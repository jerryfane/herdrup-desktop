package main

import (
	"strconv"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// Run under -race (CI does). runGuest renames the shared agent under d.mu; the share's ID that
// attachmentLink reads must be read under it too. The writer renames many times while the
// attachment asks many times, with no sleep: some ask on the old code reads the access after
// its unlock while a rename lands with no happens-before edge between them, whatever the timing.
func TestAttachmentLinkReadsTheShareUnderTheLock(t *testing.T) {
	const rounds = 10000
	d := &Desk{}
	l := &link{guest: &guest.Transport{}, access: &guest.Access{GuestID: "g"}}
	d.link = l
	d.guestGram.Store(&guestGramHub{}) // a combined guest Gram runs: the share's ID is looked up in it
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range rounds {
			d.mu.Lock()
			l.access.AgentName = strconv.Itoa(i)
			d.mu.Unlock()
		}
	}()
	for range rounds {
		if _, err := d.attachmentLink(); err == nil {
			t.Fatal("a share without Gram gave a link")
		}
	}
	<-done
}
