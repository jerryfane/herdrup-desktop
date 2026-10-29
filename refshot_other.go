//go:build !darwin

package main

import (
	"errors"

	"github.com/egoist/mygo"
)

// refDeviceScale reports no backing scale: only macOS can force the page's
// device scale, and the references are compared on macOS only.
func refDeviceScale(_ *mygo.Window, scale float64) (backing, applied float64, err error) {
	if scale > 0 {
		return 0, 0, errors.New("HERDRUP_REF_SCALE works on macOS only")
	}
	return 0, 0, nil
}
