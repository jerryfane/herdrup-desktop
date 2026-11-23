package main

import (
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// Run under -race (CI does). runGuest renames the shared agent under d.mu; the share's ID that
// attachmentLink reads must be read under it too. The order that shows an unlocked read: the
// attachment asks (lock, unlock, read), then runGuest takes the lock and writes, with nothing
// ordering the read before the write.
func TestAttachmentLinkReadsTheShareUnderTheLock(t *testing.T) {
	d := &Desk{}
	l := &link{guest: &guest.Transport{}, access: &guest.Access{GuestID: "g"}}
	d.link = l
	d.guestGram.Store(&guestGramHub{}) // a combined guest Gram runs: the share's ID is looked up in it
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Real time on purpose: a sleep orders nothing for the race detector, so the write below
		// lands after the read without a happens-before edge between them.
		time.Sleep(20 * time.Millisecond)
		d.mu.Lock()
		l.access.AgentName = "renamed"
		d.mu.Unlock()
	}()
	if _, err := d.attachmentLink(); err == nil {
		t.Fatal("a share without Gram gave a link")
	}
	<-done
}
