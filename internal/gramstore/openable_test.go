package gramstore

import "testing"

// Files an agent sends are handed to the system opener, so types the
// opener would run are refused: programs, scripts, and Windows types that
// run code when opened, such as compiled help and Explorer command files.
func TestOpenableRefusesWhatTheOpenerWouldRun(t *testing.T) {
	for name, want := range map[string]bool{
		"report.pdf":  true,
		"chart.PNG":   true,
		"README":      true,
		"notes.txt":   true,
		"setup.exe":   false,
		"Setup.EXE. ": false, // Windows drops trailing dots and spaces
		"guide.chm":   false, // compiled help runs scripts
		"desktop.scf": false, // Explorer command file
		"addin.xll":   false,
		"deploy.sh":   false,
		"run.command": false,
	} {
		if got := Openable(name); got != want {
			t.Errorf("Openable(%q) = %v, want %v", name, got, want)
		}
	}
}
