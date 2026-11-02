package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func (c *Client) AgentKinds(ctx context.Context) ([]herdrapi.AgentKindInfo, error) {
	result, err := call[herdrapi.ResponseResultAgentKinds](ctx, c, "agent.kinds", herdrapi.EmptyParams{})
	return result.Kinds, err
}

func (c *Client) ListDirectory(ctx context.Context, path *string) (herdrapi.ResponseResultDirList, error) {
	return call[herdrapi.ResponseResultDirList](ctx, c, "fs.list_dir", herdrapi.FsListDirParams{Path: path})
}

func (c *Client) SplitPane(ctx context.Context, cwd *string) (herdrapi.PaneInfo, error) {
	result, err := call[herdrapi.ResponseResultPaneInfo](ctx, c, "pane.split", herdrapi.PaneSplitParams{Direction: herdrapi.SplitDirectionDown, Cwd: cwd, Focus: true})
	return result.Pane, err
}

// StartAgentWhenShellReady follows the native client's bounded shell-rc retry.
// Only a definitive agent_pane_busy response is retried, while the shell still
// owns the foreground process group. An uncertain start is never repeated.
func (c *Client) StartAgentWhenShellReady(ctx context.Context, name, kind, pane string) (herdrapi.AgentInfo, error) {
	var deadline time.Time
	var previous error
	unsupported := false
	shellInitializing := func() (bool, error) {
		if unsupported {
			return true, nil
		}
		result, err := call[herdrapi.ResponseResultPaneProcessInfo](ctx, c, "pane.process_info", herdrapi.PaneProcessInfoParams{PaneID: &pane})
		if err == nil {
			return shellInitializing(result.ProcessInfo), nil
		}
		var old *ErrUnsupported
		if errors.As(err, &old) {
			unsupported = true
			return true, nil
		}
		var api *bridge.APIError
		var tag *ResultTagError
		var syntax *json.SyntaxError
		var typed *json.UnmarshalTypeError
		if errors.As(err, &api) || errors.As(err, &tag) || errors.As(err, &syntax) || errors.As(err, &typed) {
			return false, nil
		}
		return false, err
	}
	for {
		if previous != nil {
			if !time.Now().Before(deadline) {
				return herdrapi.AgentInfo{}, previous
			}
			ready, err := shellInitializing()
			if err != nil {
				return herdrapi.AgentInfo{}, err
			}
			if !ready {
				return herdrapi.AgentInfo{}, previous
			}
		}
		result, err := call[herdrapi.ResponseResultAgentStarted](ctx, c, "agent.start", herdrapi.AgentStartParams{Name: name, Kind: kind, PaneID: pane})
		if err == nil {
			return result.Agent, nil
		}
		var api *bridge.APIError
		if !errors.As(err, &api) || api.Code != "agent_pane_busy" {
			return herdrapi.AgentInfo{}, err
		}
		initializing, checkErr := shellInitializing()
		if checkErr != nil {
			return herdrapi.AgentInfo{}, checkErr
		}
		if !initializing {
			return herdrapi.AgentInfo{}, err
		}
		if deadline.IsZero() {
			deadline = time.Now().Add(2 * time.Second)
		}
		pause := min(100*time.Millisecond, time.Until(deadline))
		if pause <= 0 {
			return herdrapi.AgentInfo{}, err
		}
		previous = err
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return herdrapi.AgentInfo{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func shellInitializing(info herdrapi.PaneProcessInfo) bool {
	if info.ShellPID == nil || info.ForegroundProcessGroupID == nil || *info.ShellPID != *info.ForegroundProcessGroupID {
		return false
	}
	for _, process := range info.ForegroundProcesses {
		if process.PID == *info.ShellPID && (shellName(process.Name) || (len(process.Argv) > 0 && shellName(process.Argv[0]))) {
			return true
		}
	}
	return false
}

func shellName(name string) bool {
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	for i := 0; i < len(name); i++ {
		if name[i] > 127 {
			return false
		}
	}
	name = strings.TrimLeft(name, "-")
	for strings.HasSuffix(name, ".exe") {
		name = strings.TrimSuffix(name, ".exe")
	}
	for _, candidate := range [...]string{"sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh", "elvish", "xonsh", "nu", "pwsh", "powershell", "cmd"} {
		if strings.EqualFold(name, candidate) {
			return true
		}
	}
	return false
}
