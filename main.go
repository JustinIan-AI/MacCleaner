package main

import (
	"bufio"
	"bytes"
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

// stdinInputForModule returns the appropriate stdin input to auto-confirm
// interactive prompts for a given mole subcommand.
func stdinInputForModule(args []string) string {
	for _, a := range args {
		switch a {
		case "installer", "purge":
			// TUI mode: 'a' selects all items, Enter confirms selection, Enter confirms delete
			return "a\n\n"
		case "uninstall":
			// Single prompt: .Proceed? [y/N]. → auto-confirms, second prompt auto-confirms on pipe close
			return "y\n"
		case "clean", "optimize":
			// Non-interactive: just in case
			return "y\n"
		}
	}
	return "y\n"
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

		cmd.Stdin = bytes.NewBufferString(stdinInputForModule(args))

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
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"is_dir"`
	IsFile  bool   `json:"is_file"`
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
		"path":        req.Path,
		"entries":     diskEntries,
		"total_size":  totalSize,
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

// Installer scan paths (from mo installer.sh)
var installerScanPaths = []string{
	os.ExpandEnv("${HOME}/Downloads"),
	os.ExpandEnv("${HOME}/Desktop"),
	os.ExpandEnv("${HOME}/Documents"),
	os.ExpandEnv("${HOME}/Public"),
	os.ExpandEnv("${HOME}/Library/Downloads"),
	"/Users/Shared",
	"/Users/Shared/Downloads",
}

type InstallerEntry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Source string `json:"source"`
}

// scanInstallerFiles scans common download directories for installer packages.
func scanInstallerFiles() []InstallerEntry {
	var entries []InstallerEntry
	for _, basePath := range installerScanPaths {
		info, err := os.Stat(basePath)
		if err != nil || !info.IsDir() {
			continue
		}
		filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil
			}
			name := strings.ToLower(info.Name())
			if strings.HasSuffix(name, ".dmg") || strings.HasSuffix(name, ".pkg") ||
				strings.HasSuffix(name, ".mpkg") || strings.HasSuffix(name, ".iso") ||
				strings.HasSuffix(name, ".xip") || strings.HasSuffix(name, ".zip") {
				source := filepath.Dir(path)
				if strings.HasPrefix(source, os.ExpandEnv("${HOME}")) {
					source = strings.TrimPrefix(source, os.ExpandEnv("${HOME}/")+"")
				}
				entries = append(entries, InstallerEntry{
					Name:   info.Name(),
					Path:   path,
					Size:   info.Size(),
					Source: source,
				})
			}
			// Limit depth for performance
			depth := 0
			rel := strings.TrimPrefix(path, basePath)
			depth = strings.Count(rel, string(filepath.Separator))
			if depth > 3 {
				return filepath.SkipDir
			}
			return nil
		})
	}
	// Filter out entries with empty paths or paths that don't exist
	var validEntries []InstallerEntry
	for _, e := range entries {
		if e.Path == "" {
			continue
		}
		cleaned := filepath.Clean(os.ExpandEnv(strings.Replace(e.Path, "~", "${HOME}", 1)))
		if _, err := os.Stat(cleaned); os.IsNotExist(err) {
			continue
		}
		validEntries = append(validEntries, e)
	}
	entries = validEntries

	if entries == nil {
		entries = []InstallerEntry{}
	}
	return entries
}

// scanPurgeFiles runs mo purge --dry-run --debug and parses paths from output.
func scanPurgeFiles() ([]InstallerEntry, error) {
	moPath, err := exec.LookPath("mo")
	if err != nil {
		return nil, fmt.Errorf("mo not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, moPath, "purge", "--dry-run", "--debug")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// For mo purge, exit code 2 means "nothing to clean" - not an error
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 2 {
			// Nothing to clean - continue with empty output
			out = []byte{}
		} else if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			// Try without --debug
			cmd2 := exec.CommandContext(ctx, moPath, "purge", "--dry-run")
			out2, err2 := cmd2.CombinedOutput()
			if err2 != nil {
				if exitErr2, ok := err2.(*exec.ExitError); ok && exitErr2.ExitCode() == 2 {
					out = []byte{}
				} else {
					return nil, fmt.Errorf("purge scan failed: %v\n%s", err2, string(out2))
				}
			} else {
				out = out2
			}
		} else {
			return nil, fmt.Errorf("purge scan failed: %v\n%s", err, string(out))
		}
	}

	var entries []InstallerEntry
	seen := make(map[string]bool)
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		// Try to parse paths from mo purge output
		// Format examples: "node_modules    123.5MB   /path/to/project"
		// or: "  ○ /path/to/project/node_modules"
		cleaned := strings.TrimSpace(line)
		// Skip empty and header lines
		if cleaned == "" || strings.HasPrefix(cleaned, "→") || strings.HasPrefix(cleaned, "DRY") || strings.HasPrefix(cleaned, "[") {
			continue
		}
		// Try to extract path: look for lines with size + path patterns
		// Match: path pattern with size info
		parts := strings.Fields(cleaned)
		if len(parts) >= 2 {
			// Check if last part looks like a filesystem path
			lastPart := parts[len(parts)-1]
			if strings.HasPrefix(lastPart, "/") || strings.HasPrefix(lastPart, "~") {
				// The path is the last part
				filePath := lastPart
				if !seen[filePath] {
					seen[filePath] = true
					name := filepath.Base(filePath)
					if name == "." || name == "/" {
						name = filepath.Base(filepath.Dir(filePath))
					}
					entries = append(entries, InstallerEntry{
						Name: name,
						Path: filePath,
						Size: 0,
					})
				}
			}
		}
		// Also try matching: "○ /path" or "- /path" patterns
		if strings.Contains(cleaned, "/") {
			for _, word := range parts {
				if strings.HasPrefix(word, "/") || strings.HasPrefix(word, "~") {
					if !seen[word] {
						seen[word] = true
						name := filepath.Base(word)
						entries = append(entries, InstallerEntry{
							Name: name,
							Path: word,
							Size: 0,
						})
					}
				}
			}
		}
	}

	// Filter out entries with empty paths or paths that don't exist
	var validEntries []InstallerEntry
	for _, e := range entries {
		if e.Path == "" {
			continue
		}
		cleaned := filepath.Clean(os.ExpandEnv(strings.Replace(e.Path, "~", "${HOME}", 1)))
		if _, err := os.Stat(cleaned); os.IsNotExist(err) {
			continue
		}
		validEntries = append(validEntries, e)
	}
	entries = validEntries

	if entries == nil {
		entries = []InstallerEntry{}
	}
	return entries, nil
}
func handlePurgeScan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	entries, err := scanPurgeFiles()
	if err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(entries)
}

func handleInstallerScan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	entries := scanInstallerFiles()
	json.NewEncoder(w).Encode(entries)
}

// handleModuleDeleteStream deletes items by path (bypasses mo TUI for installer/purge) and streams via SSE.
func handleModuleDeleteStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	var req struct {
		Module string `json:"module"`
		Items  []struct {
			Name string `json:"name"`
			Path string `json:"path"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendSSEError(w, flusher, "无效的JSON: "+err.Error())
		return
	}
	if len(req.Items) == 0 {
		sendSSEError(w, flusher, "没有指定要删除的项目")
		return
	}

	// Development safety: set MAC_CLEANER_DRY_RUN=1 to preview without deleting
	dryRun := os.Getenv("MAC_CLEANER_DRY_RUN") == "1"
	if dryRun {
		sendSSELine(w, flusher, "stdout", "🧪 DRY RUN 模式 - 仅预览，不会执行删除操作")
	}

	// Resolve paths for installer/purge modules if items lack paths
	if len(req.Items) > 0 && req.Items[0].Path == "" {
		var resolvedEntries []InstallerEntry
		if req.Module == "installer" {
			resolvedEntries = scanInstallerFiles()
		} else if req.Module == "purge" {
			var purgeErr error
			resolvedEntries, purgeErr = scanPurgeFiles()
			if purgeErr != nil {
				sendSSEError(w, flusher, "扫描构建产物失败: "+purgeErr.Error())
				return
			}
		}

		if len(resolvedEntries) > 0 {
			// Build name->entry map for matching
			nameMap := make(map[string]InstallerEntry)
			for _, e := range resolvedEntries {
				key := strings.ToLower(e.Name)
				nameMap[key] = e
			}

			var resolvedItems []struct {
				Name string `json:"name"`
				Path string `json:"path"`
			}
			for _, item := range req.Items {
				itemName := strings.ToLower(item.Name)
				if match, ok := nameMap[itemName]; ok {
					resolvedItems = append(resolvedItems, struct {
						Name string `json:"name"`
						Path string `json:"path"`
					}{Name: match.Name, Path: match.Path})
				} else {
					// Try matching by removing extension
					for key, entry := range nameMap {
						entryBase := strings.TrimSuffix(key, filepath.Ext(key))
						itemBase := strings.TrimSuffix(itemName, filepath.Ext(itemName))
						if entryBase == itemBase {
							resolvedItems = append(resolvedItems, struct {
								Name string `json:"name"`
								Path string `json:"path"`
							}{Name: entry.Name, Path: entry.Path})
							break
						}
					}
				}
			}
			if len(resolvedItems) > 0 {
				req.Items = resolvedItems
			}
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	if req.Module != "" {
		registerCancel(req.Module, cancel)
		defer unregisterCancel(req.Module)
	}

	startTime := time.Now()
	totalSuccess := 0
	totalFail := 0
	totalSkipped := 0

	for _, item := range req.Items {
		select {
		case <-ctx.Done():
			// Send cancellation done
			doneData, _ := json.Marshal(map[string]interface{}{
				"exit_code":   -1,
				"duration_ms": time.Since(startTime).Milliseconds(),
			})
			fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
			flusher.Flush()
			return
		default:
		}

		path := item.Path
		if path == "" {
			totalSkipped++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "⚠️ 跳过 " + item.Name + ": 路径为空",
				"stream": "stderr",
			})
			fmt.Fprintf(w, "event: stderr\ndata: %s\n\n", string(data))
			flusher.Flush()
			continue
		}

		cleaned := filepath.Clean(path)
		// Safety check: prevent deleting root or home
		home := os.Getenv("HOME")
		if cleaned == "/" || (home != "" && cleaned == home) {
			totalSkipped++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "⚠️ 跳过 " + item.Name + ": 禁止删除系统关键目录",
				"stream": "stderr",
			})
			fmt.Fprintf(w, "event: stderr\ndata: %s\n\n", string(data))
			flusher.Flush()
			continue
		}

		if _, err := os.Stat(cleaned); os.IsNotExist(err) {
			totalSkipped++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "⚠️ 跳过 " + item.Name + ": 路径不存在",
				"stream": "stderr",
			})
			fmt.Fprintf(w, "event: stderr\ndata: %s\n\n", string(data))
			flusher.Flush()
			continue
		}

		if dryRun {
			totalSuccess++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "🧪 [DRY RUN] 将删除 " + item.Name,
				"stream": "stdout",
			})
			fmt.Fprintf(w, "event: stdout\ndata: %s\n\n", string(data))
			flusher.Flush()
			continue
		}

		if err := os.RemoveAll(cleaned); err != nil {
			totalFail++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "❌ 删除失败 " + item.Name + ": " + err.Error(),
				"stream": "stderr",
			})
			fmt.Fprintf(w, "event: stderr\ndata: %s\n\n", string(data))
			flusher.Flush()
		} else {
			totalSuccess++
			data, _ := json.Marshal(map[string]interface{}{
				"line":   "✅ 已删除 " + item.Name,
				"stream": "stdout",
			})
			fmt.Fprintf(w, "event: stdout\ndata: %s\n\n", string(data))
			flusher.Flush()
		}
	}

	exitCode := 0
	if totalFail > 0 {
		exitCode = 1
	}
	dur := time.Since(startTime).Milliseconds()
	summary := fmt.Sprintf("成功 %d", totalSuccess)
	if totalSkipped > 0 {
		summary += fmt.Sprintf(", 跳过 %d", totalSkipped)
	}
	if totalFail > 0 {
		summary += fmt.Sprintf(", 失败 %d", totalFail)
	}
	doneData, _ := json.Marshal(map[string]interface{}{
		"exit_code":   exitCode,
		"duration_ms": dur,
		"summary":     summary,
	})
	fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
	flusher.Flush()
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
	mux.HandleFunc("/api/installer/scan", handleInstallerScan)
	mux.HandleFunc("/api/purge/scan", handlePurgeScan)
	mux.HandleFunc("/api/module/delete-stream", handleModuleDeleteStream)
	mux.HandleFunc("/api/optimize/dry-run", sseHandler("optimize", "--dry-run"))
	mux.HandleFunc("/api/optimize/run", sseHandler("optimize"))

	fmt.Printf("  🛠️  MacCleaner running at http://localhost:%s\n", port)
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

// AppInfo represents an app to be uninstalled.
type AppInfo struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	BundleID string `json:"bundle_id"`
}

// getResidualPaths returns known residual file paths for a given bundle ID.
func getResidualPaths(bundleID string) []string {
	if bundleID == "" {
		return nil
	}
	home := os.Getenv("HOME")
	if home == "" {
		return nil
	}
	return []string{
		filepath.Join(home, "Library/Preferences", bundleID+".plist"),
		filepath.Join(home, "Library/Caches", bundleID),
		filepath.Join(home, "Library/Application Support", bundleID),
		filepath.Join(home, "Library/Saved Application State", bundleID),
		filepath.Join(home, "Library/Logs", bundleID),
		filepath.Join(home, "Library/Containers", bundleID),
		filepath.Join(home, "Library/HTTPStorages", bundleID),
		filepath.Join(home, "Library/WebKit", bundleID),
		filepath.Join(home, "Library/Group Containers", bundleID),
	}
}

// sendSSELine writes a single SSE event line.
func sendSSELine(w http.ResponseWriter, flusher http.Flusher, stream, line string) {
	data, _ := json.Marshal(map[string]string{"line": line, "stream": stream})
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", stream, string(data))
	flusher.Flush()
}

// sendSSEDone sends the done SSE event.
func sendSSEDone(w http.ResponseWriter, flusher http.Flusher, exitCode int, durationMs int64) {
	doneData, _ := json.Marshal(map[string]interface{}{
		"exit_code":   exitCode,
		"duration_ms": durationMs,
	})
	fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
	flusher.Flush()
}

// handleUninstallRunSelected directly deletes apps and residual files, streaming progress via SSE.
func handleUninstallRunSelected(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Apps []AppInfo `json:"apps"`
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

	registerCancel("uninstall", cancel)
	defer unregisterCancel("uninstall")

	home := os.Getenv("HOME")
	startTime := time.Now()
	totalSuccess := 0
	totalFail := 0

	for _, app := range req.Apps {
		select {
		case <-ctx.Done():
			sendSSEDone(w, flusher, -1, time.Since(startTime).Milliseconds())
			return
		default:
		}

		appPath := app.Path
		if strings.HasPrefix(appPath, "~") && home != "" {
			appPath = filepath.Join(home, appPath[1:])
		}
		appPath = filepath.Clean(appPath)

		if appPath == "/" || (home != "" && appPath == home) {
			totalFail++
			sendSSELine(w, flusher, "stderr", "\u26a0\ufe0f \u8df3\u8fc7 "+app.Name+": \u7981\u6b62\u5220\u9664\u7cfb\u7edf\u5173\u952e\u76ee\u5f55")
			continue
		}

		var deletedPaths []string

		// 1. Delete the .app bundle
		if appPath != "" {
			if info, err := os.Stat(appPath); err == nil {
				if info.IsDir() && (strings.HasSuffix(appPath, ".app") || strings.HasSuffix(appPath, ".prefPane")) {
					if err := os.RemoveAll(appPath); err != nil {
						totalFail++
						sendSSELine(w, flusher, "stderr", "\u274c "+app.Name+": \u5220\u9664\u5e94\u7528\u5931\u8d25: "+err.Error())
						continue
					}
					deletedPaths = append(deletedPaths, appPath)
					sendSSELine(w, flusher, "stdout", "\u2705 "+app.Name+": \u5df2\u5220\u9664\u5e94\u7528")
				} else {
					if err := os.RemoveAll(appPath); err != nil {
						sendSSELine(w, flusher, "stderr", "\u26a0\ufe0f "+app.Name+": \u5c1d\u8bd5\u5220\u9664\u5931\u8d25: "+err.Error())
					} else {
						deletedPaths = append(deletedPaths, appPath)
						sendSSELine(w, flusher, "stdout", "\u2705 "+app.Name+": \u5df2\u5220\u9664")
					}
				}
			} else if os.IsNotExist(err) {
				sendSSELine(w, flusher, "stderr", "\u26a0\ufe0f "+app.Name+": \u5e94\u7528\u4e0d\u5b58\u5728\u4e8e "+appPath)
			} else {
				sendSSELine(w, flusher, "stderr", "\u26a0\ufe0f "+app.Name+": \u65e0\u6cd5\u8bbf\u95ee "+appPath+": "+err.Error())
			}
		}

		// 2. Clean up residual files by bundle_id
		if app.BundleID != "" {
			residualPaths := getResidualPaths(app.BundleID)
			residualCount := 0
			for _, rp := range residualPaths {
				if info, err := os.Stat(rp); err == nil {
					var removeErr error
					if info.IsDir() {
						removeErr = os.RemoveAll(rp)
					} else {
						removeErr = os.Remove(rp)
					}
					if removeErr == nil {
						deletedPaths = append(deletedPaths, rp)
						residualCount++
					}
				}
			}
			if residualCount > 0 {
				sendSSELine(w, flusher, "stdout", "   \U0001f9f9 \u5df2\u6e05\u7406 "+strconv.Itoa(residualCount)+" \u4e2a\u6b8b\u7559\u6587\u4ef6")
			}
		}

		if len(deletedPaths) > 0 {
			totalSuccess++
		}
	}

	exitCode := 0
	if totalFail > 0 {
		exitCode = 1
	}
	dur := time.Since(startTime).Milliseconds()
	doneData, _ := json.Marshal(map[string]interface{}{
		"exit_code":   exitCode,
		"duration_ms": dur,
		"removed":     totalSuccess,
		"failed":      totalFail,
	})
	fmt.Fprintf(w, "event: done\ndata: %s\n\n", string(doneData))
	flusher.Flush()
}
