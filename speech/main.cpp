#include "whisper.h"
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_NULL
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include "json.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;
constexpr size_t rate = WHISPER_SAMPLE_RATE;

// Audio never leaves this process: native capture -> bounded PCM ring -> whisper.
// The control pipe carries only stop; stdout carries text, state and an RMS meter.
struct Capture {
    std::mutex mutex;
    std::condition_variable changed;
    std::vector<float> ring = std::vector<float>(rate * 30);
    std::atomic<bool> stopped{false};
    bool overflow = false;
    size_t read = 0, count = 0;
    std::atomic<float> level{0};

    static void receive(ma_device * device, void *, const void * input, ma_uint32 frames) {
        auto & self = *static_cast<Capture *>(device->pUserData);
        if (!input) return;
        const auto * pcm = static_cast<const float *>(input);
        double energy = 0;
        for (size_t i = 0; i < frames; ++i) energy += pcm[i] * pcm[i];
        self.level = std::min(1.0f, static_cast<float>(std::sqrt(energy / std::max(1u, frames))) * 8);
        {
            std::lock_guard<std::mutex> lock(self.mutex);
            if (frames > self.ring.size() - self.count) { self.overflow = true; }
            else {
                const size_t write = (self.read + self.count) % self.ring.size();
                const size_t first = std::min<size_t>(frames, self.ring.size() - write);
                std::copy_n(pcm, first, self.ring.data() + write);
                std::copy_n(pcm + first, frames - first, self.ring.data());
                self.count += frames;
            }
        }
        self.changed.notify_one();
    }
};

static void emit(const json & event) { std::cout << event.dump() << '\n' << std::flush; }
static std::string trim(std::string text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = text.find_last_not_of(" \t\r\n");
    return text.substr(first, last - first + 1);
}
static bool silentTail(const std::vector<float> & audio, size_t count) {
    count = std::min(count, audio.size());
    if (count == 0) return true;
    double energy = 0;
    for (size_t i = audio.size() - count; i < audio.size(); ++i) energy += audio[i] * audio[i];
    return energy / count < 0.000001;
}
static void transcribe(whisper_context * context, Capture & capture, const std::string & locale) {
    auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = std::max(1u, std::min(4u, std::thread::hardware_concurrency()));
    params.language = locale.c_str();
    params.translate = false;
    params.no_context = true;
    params.abort_callback = [](void * user) { return static_cast<Capture *>(user)->stopped.load(); };
    params.abort_callback_user_data = &capture;
    params.no_timestamps = true;
    params.single_segment = true;
    params.print_progress = params.print_realtime = params.print_timestamps = params.print_special = false;
    params.greedy.best_of = 1;
    std::vector<float> audio;
    audio.reserve(rate * 30);
    size_t inferred = 0;
    std::string committed, previous, partial;
    auto lastMeter = std::chrono::steady_clock::now();
    for (;;) {
        bool stopped;
        {
            std::unique_lock<std::mutex> lock(capture.mutex);
            capture.changed.wait_for(lock, std::chrono::milliseconds(100), [&] { return capture.stopped.load() || capture.count >= rate / 10 || capture.overflow; });
            if (capture.overflow || audio.size() + capture.count > rate * 30) {
                emit({{"state", "error"}, {"error", "Dictation could not keep up with the microphone. Try again with fewer applications running."}});
                std::exit(1);
            }
            const size_t first = std::min(capture.count, capture.ring.size() - capture.read);
            audio.insert(audio.end(), capture.ring.data() + capture.read, capture.ring.data() + capture.read + first);
            audio.insert(audio.end(), capture.ring.data(), capture.ring.data() + capture.count - first);
            capture.read = (capture.read + capture.count) % capture.ring.size();
            capture.count = 0;
            stopped = capture.stopped;
        }
        const auto now = std::chrono::steady_clock::now();
        if (stopped) { emit({{"state", "stopped"}}); return; }
        if (now - lastMeter >= std::chrono::milliseconds(100)) {
            emit({{"state", "recording"}, {"level", capture.level.load()}}); lastMeter = now;
        }
        const bool commit = audio.size() >= rate * 20 || (audio.size() >= rate * 10 && silentTail(audio, rate / 2));
        if (audio.size() >= rate / 2 && (commit || audio.size() >= inferred + rate)) {
            if (!silentTail(audio, audio.size())) {
                if (whisper_full(context, params, audio.data(), static_cast<int>(audio.size())) != 0) {
                    if (capture.stopped) { emit({{"state", "stopped"}}); return; }
                    emit({{"state", "error"}, {"error", "On-device speech recognition failed."}}); std::exit(1);
                }
                partial.clear();
                for (int i = 0; i < whisper_full_n_segments(context); ++i) partial += whisper_full_get_segment_text(context, i);
                partial = trim(std::move(partial));
            } else { partial.clear(); }
            inferred = audio.size();
            const std::string text = committed.empty() ? partial : partial.empty() ? committed : committed + " " + partial;
            if (text != previous) { emit({{"state", "recording"}, {"text", text}}); previous = text; }
        }
        if (commit) {
            if (!partial.empty()) { if (!committed.empty()) committed += " "; committed += partial; }
            partial.clear(); audio.clear(); inferred = 0;
        }
    }
}

int main(int argc, char ** argv) {
    if (argc != 3) { emit({{"state", "error"}, {"error", "Expected a local model path and speech locale."}}); return 2; }
    std::string locale = argv[2];
    const auto separator = locale.find_first_of("-_");
    if (separator != std::string::npos) locale.resize(separator);
    std::transform(locale.begin(), locale.end(), locale.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (whisper_lang_id(locale.c_str()) < 0) { emit({{"state", "error"}, {"error", "On-device dictation is not available for this language."}}); return 1; }
    auto options = whisper_context_default_params(); options.use_gpu = false;
    auto * context = whisper_init_from_file_with_params(argv[1], options);
    if (!context) { emit({{"state", "error"}, {"error", "The offline speech model could not be loaded. Reinstall Herdrup to restore it."}}); return 1; }
    if (!whisper_is_multilingual(context) && locale != "en") {
        whisper_free(context); emit({{"state", "error"}, {"error", "The installed speech model does not support this language."}}); return 1;
    }
    Capture capture;
    auto config = ma_device_config_init(ma_device_type_capture);
    config.capture.format = ma_format_f32;
    config.capture.channels = 1;
    config.sampleRate = rate;
    config.dataCallback = Capture::receive;
    config.pUserData = &capture;
    ma_device device;
    if (ma_device_init(nullptr, &config, &device) != MA_SUCCESS) {
        whisper_free(context); emit({{"state", "error"}, {"error", "Microphone unavailable. Allow Herdrup microphone access in system settings and try again."}}); return 1;
    }
    if (ma_device_start(&device) != MA_SUCCESS) {
        ma_device_uninit(&device); whisper_free(context); emit({{"state", "error"}, {"error", "The microphone could not start."}}); return 1;
    }
    emit({{"state", "recording"}, {"level", 0}});
    std::thread worker([&] { transcribe(context, capture, locale); });
    std::string command;
    while (std::getline(std::cin, command) && command != "stop") {}
    // Release capture before waiting for final inference, including control-pipe EOF.
    ma_device_uninit(&device);
    { std::lock_guard<std::mutex> lock(capture.mutex); capture.stopped = true; }
    capture.changed.notify_one();
    worker.join();
    whisper_free(context);
    return 0;
}
