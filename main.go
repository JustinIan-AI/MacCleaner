package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/index.html
var indexHTML []byte

//go:embed web/style.css
var styleCSS []byte

//go:embed web/app.js
var appJS []byte

// RiskMap defines risk metadata for each module, sent to frontend on load.
type RiskInfo struct {
	RiskLevel string   `json:"risk_level"`
	RiskLabel string   `json:"risk_label"`
	Color     string   `json:"color"`
	Affects   []string `json:"affects"`
	SafeZones []string `json:"safe_zones"`
}

var riskMap = map[string]RiskInfo{
	"clean": {
		RiskLevel: "medium", RiskLabel: "\U0001f7e1 中等风险", Color: "#FF9F0A",
		Affects:   []string{"系统缓存 → 自动重建", "浏览器缓存 → 需重新登录网站", "日志文件 → 安全"},
		SafeZones: []string{"个人文档", "照片", "应用数据", "系统设置"},
	},
	"uninstall": {
		RiskLevel: "high", RiskLabel: "\U0001f534 高风险", Color: "#FF453A",
		Affects:   []string{"应用及所有残留数据 → 不可恢复"},
		SafeZones: []string{"不影响其他应用", "不影响个人文档"},
	},
	"purge": {
		RiskLevel: "low", RiskLabel: "\U0001f7e2 低风险", Color: "#30D158",
		Affects:   []string{"构建产物 (node_modules/target/build) → 可重建"},
		SafeZones: []string{"项目源码", "个人文档"},
	},
	"installer": {
		RiskLevel: "low", RiskLabel: "\U0001f7e2 低风险", Color: "#30D158",
		Affects:   []string{".dmg/.pkg 安装包文件"},
		SafeZones: []string{"已安装的应用", "不影响任何功能"},
	},
	"optimize": {
		RiskLevel: "medium", RiskLabel: "\U0001f7e1 中等风险", Color: "#FF9F0A",
		Affects:   []string{"系统服务刷新 → 短暂卡顿", "DNS 缓存重置"},
		SafeZones: []string{"个人数据", "应用设置"},
	},
	"status": {
		RiskLevel: "none", RiskLabel: "\U0001f7e2 只读", Color: "#30D158",
		Affects:   []string{},
		SafeZones: []string{"不修改任何文件"},
	},
	"analyze": {
		RiskLevel: "none", RiskLabel: "\U0001f7e2 只读", Color: "#30D158",
		Affects:   []string{},
		SafeZones: []string{"扫描只读，删除时移至废纸篓"},
	},
}

// runningCancel tracks cancel functions for in-flight SSE commands, keyed by module.
var (
	runningCancel   = make(map[string]context.CancelFunc)
	runningCancelMu sync.Mutex
)

func registerCancel(module string, cancel context.CancelFunc) {
	runningCancelMu.Lock()
	runningCancel[module] = cancel
	runningCancelMu.Unlock()
}

func unregisterCancel(module string) {
	runningCancelMu.Lock()
	delete(runningCancel, module)
	runningCancelMu.Unlock()
}

func getCancel(module string) context.CancelFunc {
	runningCancelMu.Lock()
	defer runningCancelMu.Unlock()
	return runningCancel[module]
}

func handleRiskMap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(riskMap)
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	output, err := runMoCapture("status", "--json")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(output))
}

func handleAnalyze(w http.ResponseWriter, r *http.Request) {
	output, err := runMoCapture("analyze", "-json")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(output))
}

func handleHistory(w http.ResponseWriter, r *http.Request) {
	output, err := runMoCapture("history", "--json")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(output))
}

// runMoCapture runs a mo command and returns its combined output.
func runMoCapture(args ...string) (string, error) {
	moPath, err := exec.LookPath("mo")
	if err != nil {
		return "", fmt.Errorf("mo not found. Install with: brew install mo")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, moPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("command failed: %w\n%s", err, string(out))
	}
	return string(out), nil
}

// extractModule derives the mole subcommand name from args (e.g. "clean", "uninstall").
func extractModule(args []string) string {
	for _, a := range args {
		if a != "--dry-run" && a != "--debug" && a != "-json" {
			return a
		}
	}
	return ""
}

// sseHandler returns an HTTP handler that runs a mo command and streams output via SSE.
func sseHandler(args ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		moPath, err := exec.LookPath("mo")
		if err != nil {
			fmt.Fprintf(w, "event: stderr\ndata: {\"line\":\"错误: 未找到 mo 命令。请先安装: brew install mo\"}\n\n")
			fmt.Fprintf(w, "event: done\ndata: {\"exit_code\":1,\"duration_ms\":0}\n\n")
			flusher.Flush()
			return
		}

		modKey := extractModule(args)
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()

		// Register so /api/stop can cancel this command
		if modKey != "" {
			registerCancel(modKey, cancel)
			defer unregisterCancel(modKey)
		}

		cmd := exec.CommandContext(ctx, moPath, args...)

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			http.Error(w, "Failed to create stdout pipe", http.StatusInternalServerError)
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			http.Error(w, "Failed to create stderr pipe", http.StatusInternalServerError)
			return
		}

		if err := cmd.Start(); err != nil {
			sendSSEError(w, flusher, err.Error())
			return
		}

		// Channel for collecting output lines
		type line struct {
			Text   string `json:"line"`
			Stream string `json:"stream"`
		}
		lines := make(chan line, 100)

		go func() {
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				lines <- line{Text: scanner.Text(), Stream: "stdout"}
			}
		}()

		go func() {
			scanner := bufio.NewScanner(stderr)
			for scanner.Scan() {
				lines <- line{Text: scanner.Text(), Stream: "stderr"}
			}
		}()

		startTime := time.Now()
		done := make(chan error, 1)
		go func() {
			done <- cmd.Wait()
		}()

		streamLines := true
		for streamLines {
			select {
			case l := <-lines:
				data, _ := json.Marshal(l)
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", l.Stream, string(data))
				flusher.Flush()
			case err := <-done:
				drain := true
				for drain {
					select {
					case l := <-lines:
						data, _ := json.Marshal(l)
						fmt.Fprintf(w, "event: %s\ndata: %s\n\n", l.Stream, string(data))
						flusher.Flush()
					default:
						drain = false
					}
				}
				exitCode := 0
				if err != nil {
					if exitErr, ok := err.(*exec.ExitError); ok {
						exitCode = exitErr.ExitCode()
					} else {
						exitCode = 1
					}
				}
				dur := time.Since(startTime).Milliseconds()
				doneData, _ := json.Marshal(map[string]interface{}{
					"exit_code":   exitCode,
					"duration_ms": dur,
				})
				fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
				flusher.Flush()
				streamLines = false
			case <-ctx.Done():
				fmt.Fprintf(w, "event: done\ndata: {\"exit_code\":-1,\"duration_ms\":%d}\n\n", time.Since(startTime).Milliseconds())
				flusher.Flush()
				streamLines = false
			}
		}
	}
}

func sendSSEError(w http.ResponseWriter, flusher http.Flusher, msg string) {
	data, _ := json.Marshal(map[string]string{"line": "错误: " + msg, "stream": "stderr"})
	fmt.Fprintf(w, "event: stderr\ndata: %s\n\n", string(data))
	fmt.Fprintf(w, "event: done\ndata: {\"exit_code\":1,\"duration_ms\":0}\n\n")
	flusher.Flush()
}

// DiskEntry represents a file or directory in scan results
type DiskEntry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	IsDir  bool   `json:"is_dir"`
	IsFile bool   `json:"is_file"`
	SizeStr string `json:"size_str"`
}

// handleDiskScan scans a directory and returns disk usage info
func handleDiskScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Default to home directory if path is empty
	if req.Path == "" || req.Path == "/" {
		home, err := os.UserHomeDir()
		if err != nil {
			req.Path = "/"
		} else {
			req.Path = home
		}
	}

	// Expand ~ to home directory
	if strings.HasPrefix(req.Path, "~") {
		home, _ := os.UserHomeDir()
		req.Path = filepath.Join(home, req.Path[1:])
	}

	// Verify directory exists
	info, err := os.Stat(req.Path)
	if err != nil || !info.IsDir() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Directory not found: " + req.Path})
		return
	}

	// Read directory entries
	entries, err := os.ReadDir(req.Path)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	// Get sizes in parallel using du for directories, os.Stat for files
	type result struct {
		name string
		size int64
		err  error
	}
	results := make(chan result, len(entries))

	for _, entry := range entries {
		go func(entry os.DirEntry) {
			fullPath := filepath.Join(req.Path, entry.Name())
			if entry.IsDir() {
				// Use du -sk for directories
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, "du", "-sk", fullPath)
				out, err := cmd.Output()
				if err != nil {
					results <- result{name: entry.Name(), size: 0}
					return
				}
				parts := strings.Fields(string(out))
				if len(parts) > 0 {
					size, _ := strconv.ParseInt(parts[0], 10, 64)
					results <- result{name: entry.Name(), size: size * 1024} // du -sk gives KB
				} else {
					results <- result{name: entry.Name(), size: 0}
				}
			} else {
				info, err := entry.Info()
				if err != nil {
					results <- result{name: entry.Name(), size: 0}
					return
				}
				results <- result{name: entry.Name(), size: info.Size()}
			}
		}(entry)
	}

	// Collect results
	var diskEntries []DiskEntry
	var totalSize int64
	var totalCount int

	for i := 0; i < len(entries); i++ {
		res := <-results
		totalSize += res.size
		if res.err == nil {
			totalCount++
		}
		// Find the entry
		var entry os.DirEntry
		for _, e := range entries {
			if e.Name() == res.name {
				entry = e
				break
			}
		}
		diskEntries = append(diskEntries, DiskEntry{
			Name:    res.name,
			Path:    filepath.Join(req.Path, res.name),
			Size:    res.size,
			IsDir:   entry != nil && entry.IsDir(),
			IsFile:  entry != nil && !entry.IsDir(),
			SizeStr: formatSize(res.size),
		})
	}

	// Sort by size descending
	for i := 0; i < len(diskEntries); i++ {
		for j := i + 1; j < len(diskEntries); j++ {
			if diskEntries[j].Size > diskEntries[i].Size {
				diskEntries[i], diskEntries[j] = diskEntries[j], diskEntries[i]
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"path":       req.Path,
		"entries":    diskEntries,
		"total_size": totalSize,
		"total_count": totalCount,
	})
}

// handleDiskDelete removes files/directories from disk after user consent
func handleDiskDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if len(req.Paths) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "No paths provided",
		})
		return
	}

	type deleteResult struct {
		Path    string `json:"path"`
		Error   string `json:"error,omitempty"`
		Removed bool   `json:"removed"`
	}

	results := make([]deleteResult, 0, len(req.Paths))
	home := os.Getenv("HOME")

	for _, path := range req.Paths {
		cleaned := filepath.Clean(path)
		if cleaned == "/" || (home != "" && cleaned == home) {
			results = append(results, deleteResult{Path: path, Error: "禁止删除系统关键目录", Removed: false})
			continue
		}
		if _, err := os.Stat(cleaned); os.IsNotExist(err) {
			results = append(results, deleteResult{Path: path, Error: "路径不存在", Removed: false})
			continue
		} else if err != nil {
			results = append(results, deleteResult{Path: path, Error: err.Error(), Removed: false})
			continue
		}
		if err := os.RemoveAll(cleaned); err != nil {
			results = append(results, deleteResult{Path: path, Error: err.Error(), Removed: false})
		} else {
			results = append(results, deleteResult{Path: path, Removed: true})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"results": results,
	})
}

func formatSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%dB", bytes)
	} else if bytes < 1024*1024 {
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	} else if bytes < 1024*1024*1024 {
		return fmt.Sprintf("%.1fMB", float64(bytes)/(1024*1024))
	} else {
		return fmt.Sprintf("%.1fGB", float64(bytes)/(1024*1024*1024))
	}
}

// handleStop cancels a running command by module name.
func handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	module := r.URL.Query().Get("module")
	if module == "" {
		http.Error(w, "module required", http.StatusBadRequest)
		return
	}
	if cancel := getCancel(module); cancel != nil {
		cancel()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelled", "module": module})
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "idle", "module": module})
	}
}

func main() {
	port := "4399"
	if p := os.Getenv("MOLE_TOOL_PORT"); p != "" {
		port = p
	}

	mux := http.NewServeMux()

	// Static files
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexHTML)
		case "/style.css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			w.Write(styleCSS)
		case "/app.js":
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Write(appJS)
		default:
			http.NotFound(w, r)
		}
	})

	// API routes
	mux.HandleFunc("/api/status", handleStatus)
	mux.HandleFunc("/api/analyze", handleAnalyze)
	mux.HandleFunc("/api/history", handleHistory)
	mux.HandleFunc("/api/risk-map", handleRiskMap)
	mux.HandleFunc("/api/disk/scan", handleDiskScan)
	mux.HandleFunc("/api/disk/delete", handleDiskDelete)
	mux.HandleFunc("/api/stop", handleStop)

	// SSE routes (dry-run and run)
	mux.HandleFunc("/api/clean/dry-run", sseHandler("clean", "--dry-run", "--debug"))
	mux.HandleFunc("/api/clean/run", sseHandler("clean"))
	mux.HandleFunc("/api/uninstall/dry-run", sseHandler("uninstall", "--dry-run"))
	mux.HandleFunc("/api/uninstall/run", sseHandler("uninstall"))
	mux.HandleFunc("/api/uninstall/list", handleUninstallList)
	mux.HandleFunc("/api/uninstall/run-selected", handleUninstallRunSelected)
	mux.HandleFunc("/api/purge/dry-run", sseHandler("purge", "--dry-run"))
	mux.HandleFunc("/api/purge/run", sseHandler("purge"))
	mux.HandleFunc("/api/installer/dry-run", sseHandler("installer", "--dry-run"))
	mux.HandleFunc("/api/installer/run", sseHandler("installer"))
	mux.HandleFunc("/api/optimize/dry-run", sseHandler("optimize", "--dry-run"))
	mux.HandleFunc("/api/optimize/run", sseHandler("optimize"))

	fmt.Printf("  🛠️  Mole Tool running at http://localhost:%s\n", port)
	fmt.Printf("  Press Ctrl+C to stop\n")

	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func handleUninstallList(w http.ResponseWriter, r *http.Request) {
	output, err := runMoCapture("uninstall", "--list")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// mo uninstall --list returns a JSON array directly - pass it through
	w.Write([]byte(output))
}

// handleUninstallRunSelected runs mo uninstall with selected app names and streams via SSE.
func handleUninstallRunSelected(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Apps []string `json:"apps"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if len(req.Apps) == 0 {
		http.Error(w, "No apps specified", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	moPath, err := exec.LookPath("mo")
	if err != nil {
		sendSSEError(w, flusher, "mo not found. Install with: brew install mo")
		return
	}

	// Register cancel for this module
	registerCancel("uninstall", cancel)
	defer unregisterCancel("uninstall")

	args := append([]string{"uninstall", "--dry-run"}, req.Apps...)
	cmd := exec.CommandContext(ctx, moPath, args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "Failed to create stdout pipe", http.StatusInternalServerError)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		http.Error(w, "Failed to create stderr pipe", http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		sendSSEError(w, flusher, err.Error())
		return
	}

	type line struct {
		Text   string `json:"line"`
		Stream string `json:"stream"`
	}
	lines := make(chan line, 100)

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- line{Text: scanner.Text(), Stream: "stdout"}
		}
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			lines <- line{Text: scanner.Text(), Stream: "stderr"}
		}
	}()

	startTime := time.Now()
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	streamLines := true
	for streamLines {
		select {
		case l := <-lines:
			data, _ := json.Marshal(l)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", l.Stream, string(data))
			flusher.Flush()
		case err := <-done:
			// Drain remaining lines
			for {
				select {
				case l := <-lines:
					data, _ := json.Marshal(l)
					fmt.Fprintf(w, "event: %s\ndata: %s\n\n", l.Stream, string(data))
					flusher.Flush()
				default:
					goto drainDone
				}
			}
			drainDone:
			exitCode := 0
			if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					exitCode = exitErr.ExitCode()
				} else {
					exitCode = 1
				}
			}
			dur := time.Since(startTime).Milliseconds()
			doneData, _ := json.Marshal(map[string]interface{}{
				"exit_code":   exitCode,
				"duration_ms": dur,
			})
			fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
			flusher.Flush()
			streamLines = false
		case <-ctx.Done():
			fmt.Fprintf(w, "event: done\ndata: {\"exit_code\":-1,\"duration_ms\":%d}\n\n", time.Since(startTime).Milliseconds())
			flusher.Flush()
			streamLines = false
		}
	}
}
