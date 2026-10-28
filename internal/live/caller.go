package live

import (
	"context"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// BridgeCaller adapts a bridge.Client to Caller.
type BridgeCaller struct{ *bridge.Client }

// OpenStream implements Caller.
func (b BridgeCaller) OpenStream(ctx context.Context, method string, params any) (Stream, error) {
	s, err := b.Client.OpenStream(ctx, method, params)
	if err != nil {
		return nil, err
	}
	return s, nil
}
