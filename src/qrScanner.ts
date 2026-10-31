import jsQR from "jsqr";

/** One camera lifetime. Disposal also stops a stream whose permission request
 * resolves after the sheet has closed; no frame is decoded after disposal. */
export function scanQR(video: HTMLVideoElement, found: (text: string) => void, unavailable: (message: string) => void): () => void {
  let disposed = false, stream: MediaStream | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
  function stop() {
    if (disposed) return;
    disposed = true; clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    video.pause(); video.srcObject = null;
    document.removeEventListener("visibilitychange", visibility);
  }
  function fail(message: string) { if (!disposed) { stop(); unavailable(message); } }
  function visibility() { if (document.hidden) fail("The camera stopped when this window went into the background. Try again when you are ready."); }
  function frame() {
    if (disposed) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && context) {
        const width = Math.min(960, video.videoWidth), height = Math.round(width * video.videoHeight / video.videoWidth);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height), code = jsQR(image.data, width, height);
        if (code?.data) { const text = code.data; stop(); found(text); return; }
      }
      timer = setTimeout(frame, 150);
    } catch { fail("The camera image could not be read. Close this sheet and try again."); }
  }
  document.addEventListener("visibilitychange", visibility);
  void (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !context) { fail("Camera capture is unavailable in this window. You can still add a host manually."); return; }
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (disposed) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; video.srcObject = acquired;
      for (const track of acquired.getVideoTracks()) track.addEventListener("ended", () => fail("The camera disconnected. Check it and try again."), { once: true });
      await video.play(); if (!disposed) frame();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      fail(name === "NotAllowedError" || name === "SecurityError" ? "Camera access was denied. Allow Herdrup to use the camera in your privacy settings, then try again. You can also add a host manually." : name === "NotFoundError" ? "No camera was found. Connect a camera, or add a host manually." : "The camera could not start. Another app may be using it; close that app and try again.");
    }
  })();
  return stop;
}
