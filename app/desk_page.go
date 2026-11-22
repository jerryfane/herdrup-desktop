package main

import "log"

// maxPageError bounds one reported page error (a stack trace is a few KB).
const maxPageError = 4000

// ReportPageError logs an error the page can't show itself: an uncaught error
// or rejection, or a startup that failed or never finished (main.ts). It goes
// to the app's output, so a device without a console (RoverOS under cage)
// keeps it in its journal.
func (d *Desk) ReportPageError(message string) {
	if len(message) > maxPageError {
		message = message[:maxPageError]
	}
	log.Printf("page error: %s", message)
}
