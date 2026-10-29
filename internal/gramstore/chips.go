package gramstore

import (
	"fmt"
	"math"
)

// ChipKind is an attachment chip's state (herdrup ComposerAttachmentState).
type ChipKind string

const (
	ChipReady        ChipKind = "ready"
	ChipWaiting      ChipKind = "waiting"
	ChipUploading    ChipKind = "uploading"
	ChipUploaded     ChipKind = "uploaded"
	ChipUploadFailed ChipKind = "uploadFailed"
	ChipSending      ChipKind = "sending"
	ChipSent         ChipKind = "sent"
	ChipFailed       ChipKind = "failed"
)

// ChipState is one chip's state, with the bytes of a running upload.
type ChipState struct {
	Kind        ChipKind
	Sent, Total int64
}

// ChipStateFor is one staged file's chip, the same rule as herdrup's
// ComposerAttachmentState.for: phase is its upload (nil when the uploader
// does not know it), sending whether a send runs and sendingPath the file
// it is on, failedPath the file the last send stopped on.
func ChipStateFor(a Attachment, phase *Phase, sending bool, sendingPath, failedPath string) ChipState {
	if a.Path == failedPath {
		return ChipState{Kind: ChipFailed}
	}
	if a.MessageID != "" {
		return ChipState{Kind: ChipSent}
	}
	if phase == nil {
		switch {
		case !sending:
			return ChipState{Kind: ChipReady}
		case a.Path == sendingPath:
			return ChipState{Kind: ChipSending}
		}
		return ChipState{Kind: ChipWaiting}
	}
	switch phase.Kind {
	case PhaseUploading:
		return ChipState{Kind: ChipUploading, Sent: phase.Sent, Total: phase.Total}
	case PhaseQueued, PhasePaused:
		return ChipState{Kind: ChipWaiting}
	case PhaseFailed:
		return ChipState{Kind: ChipUploadFailed}
	}
	if sending && a.Path == sendingPath {
		return ChipState{Kind: ChipSending}
	}
	return ChipState{Kind: ChipUploaded}
}

// Progress is a running upload's share in [0, 1]; ok is false when there
// is nothing measurable.
func (s ChipState) Progress() (fraction float64, ok bool) {
	if s.Kind != ChipUploading || s.Total <= 0 {
		return 0, false
	}
	return min(1, max(0, float64(s.Sent)/float64(s.Total))), true
}

// Failed reports a chip drawn as failed.
func (s ChipState) Failed() bool { return s.Kind == ChipFailed || s.Kind == ChipUploadFailed }

// Indeterminate reports a chip whose ring spins rather than fills.
func (s ChipState) Indeterminate() bool {
	return s.Kind == ChipSending || (s.Kind == ChipUploading && s.Total <= 0)
}

// Label is the chip's status line (herdrup ComposerAttachmentState.label).
func (s ChipState) Label(size int64) string {
	sizeLabel := DisplaySize(uint64(max(0, size)))
	switch s.Kind {
	case ChipReady, ChipUploaded:
		return sizeLabel + " · Ready"
	case ChipWaiting:
		return sizeLabel + " · Waiting"
	case ChipUploading:
		p, ok := s.Progress()
		if !ok {
			return "Uploading…"
		}
		return fmt.Sprintf("%d%% · %s", int(math.Round(p*100)), sizeLabel)
	case ChipUploadFailed:
		return "Upload failed · tap to retry"
	case ChipSending:
		return "Sending…"
	case ChipSent:
		return "Sent · " + sizeLabel
	case ChipFailed:
		return "Failed · tap send to retry"
	}
	return ""
}

// DisplaySize is a byte count as herdrup shows it (GramFile.displaySize):
// "N B" under 1 KiB, "%.0f KB" under 1 MiB, else "%.1f MB".
func DisplaySize(size uint64) string {
	b := float64(size)
	switch {
	case b < 1024:
		return fmt.Sprintf("%d B", size)
	case b < 1024*1024:
		return fmt.Sprintf("%.0f KB", b/1024)
	}
	return fmt.Sprintf("%.1f MB", b/(1024*1024))
}

// DownloadedLabel is a download's "<done> of <size>" line (herdrup
// GramFile.downloadedLabel). The desk downloads in gram.get_file_chunk
// pieces, so done counts file bytes and needs none of herdrup's 3/4
// scaling of base64 reply bytes; it never passes the size.
func DownloadedLabel(done, size uint64) string {
	return DisplaySize(min(done, size)) + " of " + DisplaySize(size)
}
