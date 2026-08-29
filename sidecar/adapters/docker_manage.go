package adapters

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
)

// 本文件是沙箱桌面平台(见 docs/superpowers/specs/2026-08-28-desktop-automation-design.md)
// 所需的 Docker 编排能力补齐:完整参数建容器 / 镜像构建 / 文件出入箱 / 暂停与检查点 /
// 自定义网络。全部是通用 Docker 管理能力,不含沙箱业务语义(语义层在 Rust 侧)。

// PortBindingSpec 一条端口发布规则;HostPort 为 0 时由 Docker 自动分配,
// HostIP 默认 127.0.0.1(只对本机回环发布,不暴露到局域网)。
type PortBindingSpec struct {
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol,omitempty"`
	HostIP        string `json:"hostIp,omitempty"`
	HostPort      int    `json:"hostPort,omitempty"`
}

// CreateContainerSpec 完整容器创建配置。NetworkMode 取值 "default"/"bridge"/"host"/"none"
// 或自定义网络名(如沙箱 restricted 档的隔离网络)。
type CreateContainerSpec struct {
	Name           string            `json:"name,omitempty"`
	Image          string            `json:"image"`
	Cmd            []string          `json:"cmd,omitempty"`
	Env            []string          `json:"env,omitempty"`
	WorkingDir     string            `json:"workingDir,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	Ports          []PortBindingSpec `json:"ports,omitempty"`
	MemoryMB       int64             `json:"memoryMb,omitempty"`
	CPUCores       float64           `json:"cpuCores,omitempty"`
	CapDrop        []string          `json:"capDrop,omitempty"`
	SecurityOpt    []string          `json:"securityOpt,omitempty"`
	ReadonlyRootfs bool              `json:"readonlyRootfs,omitempty"`
	Tmpfs          map[string]string `json:"tmpfs,omitempty"`
	Binds          []string          `json:"binds,omitempty"`
	NetworkMode    string            `json:"networkMode,omitempty"`
	Start          bool              `json:"start,omitempty"`
}

// CreateContainerResult 创建结果;Start=true 时回读实际端口绑定(自动分配场景)。
type CreateContainerResult struct {
	ID       string     `json:"id"`
	Warnings []string   `json:"warnings,omitempty"`
	Started  bool       `json:"started"`
	Ports    []PortInfo `json:"ports,omitempty"`
}

// buildContainerConfigs 把 spec 翻译成 docker SDK 的三份配置;纯函数,便于单测。
func buildContainerConfigs(spec *CreateContainerSpec) (*container.Config, *container.HostConfig, error) {
	if strings.TrimSpace(spec.Image) == "" {
		return nil, nil, fmt.Errorf("image is required")
	}

	cfg := &container.Config{
		Image:        spec.Image,
		Cmd:          spec.Cmd,
		Env:          spec.Env,
		WorkingDir:   spec.WorkingDir,
		Labels:       spec.Labels,
		ExposedPorts: nat.PortSet{},
	}
	host := &container.HostConfig{
		Binds:          spec.Binds,
		CapDrop:        spec.CapDrop,
		SecurityOpt:    spec.SecurityOpt,
		ReadonlyRootfs: spec.ReadonlyRootfs,
		Tmpfs:          spec.Tmpfs,
		PortBindings:   nat.PortMap{},
	}

	if spec.MemoryMB > 0 {
		host.Memory = spec.MemoryMB << 20
	}
	if spec.CPUCores > 0 {
		host.NanoCPUs = int64(spec.CPUCores * 1e9)
	}
	if spec.NetworkMode != "" {
		host.NetworkMode = container.NetworkMode(spec.NetworkMode)
	}

	for _, p := range spec.Ports {
		if p.ContainerPort <= 0 {
			return nil, nil, fmt.Errorf("invalid containerPort %d", p.ContainerPort)
		}
		if p.HostPort < 0 || p.HostPort > 65535 {
			return nil, nil, fmt.Errorf("invalid hostPort %d", p.HostPort)
		}
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		hostIP := p.HostIP
		if hostIP == "" {
			hostIP = "127.0.0.1"
		}
		portKey := nat.Port(fmt.Sprintf("%d/%s", p.ContainerPort, proto))
		cfg.ExposedPorts[portKey] = struct{}{}
		host.PortBindings[portKey] = append(host.PortBindings[portKey], nat.PortBinding{
			HostIP:   hostIP,
			HostPort: fmt.Sprintf("%d", p.HostPort), // "0" = 自动分配
		})
	}
	if len(cfg.ExposedPorts) == 0 {
		cfg.ExposedPorts = nil
	}
	if len(host.PortBindings) == 0 {
		host.PortBindings = nil
	}
	return cfg, host, nil
}

// CreateContainer 创建(可选启动)容器;Start=true 时启动后 inspect 回读端口绑定。
func (a *DockerAdapter) CreateContainer(spec *CreateContainerSpec) (*CreateContainerResult, error) {
	cfg, host, err := buildContainerConfigs(spec)
	if err != nil {
		return nil, err
	}

	ctx, cancel := dockerAPIContext()
	defer cancel()
	resp, err := a.cli.ContainerCreate(ctx, cfg, host, &network.NetworkingConfig{}, nil, spec.Name)
	if err != nil {
		return nil, fmt.Errorf("create container: %w", err)
	}

	result := &CreateContainerResult{ID: resp.ID, Warnings: resp.Warnings}
	if !spec.Start {
		return result, nil
	}

	if err := a.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return nil, fmt.Errorf("start container %s: %w", resp.ID[:12], err)
	}
	result.Started = true

	info, err := a.cli.ContainerInspect(ctx, resp.ID)
	if err != nil {
		return result, fmt.Errorf("inspect after start: %w", err)
	}
	for portKey, bindings := range info.NetworkSettings.Ports {
		for _, b := range bindings {
			var private, public int
			_, _ = fmt.Sscanf(string(portKey), "%d/", &private)
			_, _ = fmt.Sscanf(b.HostPort, "%d", &public)
			proto := "tcp"
			if idx := strings.Index(string(portKey), "/"); idx >= 0 {
				proto = string(portKey)[idx+1:]
			}
			result.Ports = append(result.Ports, PortInfo{Private: private, Public: public, Type: proto})
		}
	}
	return result, nil
}

// PauseContainer 暂停容器(沙箱 pause,对应 E2B pause)。
func (a *DockerAdapter) PauseContainer(containerID string) error {
	ctx, cancel := dockerAPIContext()
	defer cancel()
	return a.cli.ContainerPause(ctx, containerID)
}

// UnpauseContainer 恢复容器。
func (a *DockerAdapter) UnpauseContainer(containerID string) error {
	ctx, cancel := dockerAPIContext()
	defer cancel()
	return a.cli.ContainerUnpause(ctx, containerID)
}

// CommitContainer 把容器当前状态固化为镜像(沙箱检查点)。reference 形如 "repo:tag"。
func (a *DockerAdapter) CommitContainer(containerID, reference, comment string) (string, error) {
	if strings.TrimSpace(reference) == "" {
		return "", fmt.Errorf("reference is required")
	}
	ctx, cancel := dockerAPIContext()
	defer cancel()
	resp, err := a.cli.ContainerCommit(ctx, containerID, container.CommitOptions{
		Reference: reference,
		Comment:   comment,
	})
	if err != nil {
		return "", fmt.Errorf("commit container: %w", err)
	}
	return resp.ID, nil
}

// CopyFileEntry 一个待写入容器的文件;Content 为 base64。
type CopyFileEntry struct {
	Name    string `json:"name"`
	Mode    int64  `json:"mode,omitempty"`
	Content string `json:"content"`
}

// dockerCopyMaxBytes 单次出入箱的总字节上限,防 JSON 通道被超大文件打爆。
const dockerCopyMaxBytes = 32 << 20

// buildFilesTar 把文件列表打成 docker cp 语义的 tar 包;纯函数,便于单测。
func buildFilesTar(files []CopyFileEntry) (*bytes.Buffer, error) {
	if len(files) == 0 {
		return nil, fmt.Errorf("files is empty")
	}
	buf := &bytes.Buffer{}
	tw := tar.NewWriter(buf)
	total := 0
	for _, f := range files {
		if strings.TrimSpace(f.Name) == "" {
			return nil, fmt.Errorf("file name is empty")
		}
		data, err := base64.StdEncoding.DecodeString(f.Content)
		if err != nil {
			return nil, fmt.Errorf("decode %s: %w", f.Name, err)
		}
		total += len(data)
		if total > dockerCopyMaxBytes {
			return nil, fmt.Errorf("files exceed %d bytes limit", dockerCopyMaxBytes)
		}
		mode := f.Mode
		if mode == 0 {
			mode = 0o644
		}
		if err := tw.WriteHeader(&tar.Header{
			Name:    f.Name,
			Mode:    mode,
			Size:    int64(len(data)),
			ModTime: time.Now(),
		}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf, nil
}

// CopyToContainer 把若干文件写入容器内 destPath 目录(docker cp 语义)。
func (a *DockerAdapter) CopyToContainer(containerID, destPath string, files []CopyFileEntry) error {
	if strings.TrimSpace(destPath) == "" {
		return fmt.Errorf("destPath is required")
	}
	tarBuf, err := buildFilesTar(files)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerLongOpTimeout)
	defer cancel()
	return a.cli.CopyToContainer(ctx, containerID, destPath, tarBuf, container.CopyToContainerOptions{})
}

// CopyFromResult 从容器读出的单个文件;Content 为 base64。
type CopyFromResult struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Content string `json:"content"`
}

// extractSingleFileFromTar 取出 tar 流中第一个常规文件;纯函数,便于单测。
func extractSingleFileFromTar(r io.Reader) (string, []byte, error) {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return "", nil, fmt.Errorf("no regular file in tar stream")
		}
		if err != nil {
			return "", nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tr, dockerCopyMaxBytes+1))
		if err != nil {
			return "", nil, err
		}
		if len(data) > dockerCopyMaxBytes {
			return "", nil, fmt.Errorf("file exceeds %d bytes limit", dockerCopyMaxBytes)
		}
		return hdr.Name, data, nil
	}
}

// CopyFromContainer 从容器读出单个文件;目录路径报错(只支持单文件)。
func (a *DockerAdapter) CopyFromContainer(containerID, srcPath string) (*CopyFromResult, error) {
	if strings.TrimSpace(srcPath) == "" {
		return nil, fmt.Errorf("srcPath is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerLongOpTimeout)
	defer cancel()
	reader, stat, err := a.cli.CopyFromContainer(ctx, containerID, srcPath)
	if err != nil {
		return nil, fmt.Errorf("copy from container: %w", err)
	}
	defer reader.Close()
	if stat.Mode.IsDir() {
		return nil, fmt.Errorf("%s is a directory; only single file copy is supported", srcPath)
	}
	name, data, err := extractSingleFileFromTar(reader)
	if err != nil {
		return nil, fmt.Errorf("extract %s: %w", srcPath, err)
	}
	return &CopyFromResult{
		Name:    name,
		Size:    int64(len(data)),
		Content: base64.StdEncoding.EncodeToString(data),
	}, nil
}

// BuildImageResult 镜像构建结果。
type BuildImageResult struct {
	ImageID string   `json:"imageId,omitempty"`
	Lines   []string `json:"lines"`
}

// buildDockerfileTar 把单份 Dockerfile 打成构建上下文;纯函数,便于单测。
func buildDockerfileTar(dockerfile string) (*bytes.Buffer, error) {
	if strings.TrimSpace(dockerfile) == "" {
		return nil, fmt.Errorf("dockerfile is empty")
	}
	buf := &bytes.Buffer{}
	tw := tar.NewWriter(buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:    "Dockerfile",
		Mode:    0o644,
		Size:    int64(len(dockerfile)),
		ModTime: time.Now(),
	}); err != nil {
		return nil, err
	}
	if _, err := tw.Write([]byte(dockerfile)); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf, nil
}

// dockerBuildStreamLine 构建输出流的一行 JSON。
type dockerBuildStreamLine struct {
	Stream string `json:"stream"`
	Aux    *struct {
		ID string `json:"ID"`
	} `json:"aux"`
	ErrorDetail *struct {
		Message string `json:"message"`
	} `json:"errorDetail"`
}

// parseBuildStreamLine 解析一行构建输出,返回 (展示文本, 镜像ID, 错误);纯函数,便于单测。
func parseBuildStreamLine(line []byte) (string, string, error) {
	var entry dockerBuildStreamLine
	if err := json.Unmarshal(line, &entry); err != nil {
		return "", "", fmt.Errorf("parse build line: %w", err)
	}
	if entry.ErrorDetail != nil {
		return "", "", fmt.Errorf("build failed: %s", entry.ErrorDetail.Message)
	}
	if entry.Aux != nil && entry.Aux.ID != "" {
		return "", entry.Aux.ID, nil
	}
	return strings.TrimRight(entry.Stream, "\n"), "", nil
}

// BuildImage 从单份 Dockerfile 构建镜像(沙箱模板构建)。tag 必填。
func (a *DockerAdapter) BuildImage(dockerfile, tag string, pullParent bool) (*BuildImageResult, error) {
	if strings.TrimSpace(tag) == "" {
		return nil, fmt.Errorf("tag is required")
	}
	tarBuf, err := buildDockerfileTar(dockerfile)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), dockerLongOpTimeout)
	defer cancel()
	resp, err := a.cli.ImageBuild(ctx, tarBuf, build.ImageBuildOptions{
		Tags:       []string{tag},
		Dockerfile: "Dockerfile",
		PullParent: pullParent,
		Remove:     true,
	})
	if err != nil {
		return nil, fmt.Errorf("image build: %w", err)
	}
	defer resp.Body.Close()

	result := &BuildImageResult{}
	decoder := json.NewDecoder(resp.Body)
	for decoder.More() {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return result, fmt.Errorf("read build stream: %w", err)
		}
		text, imageID, err := parseBuildStreamLine(raw)
		if err != nil {
			return result, err
		}
		if imageID != "" {
			result.ImageID = imageID
		}
		if text != "" {
			result.Lines = append(result.Lines, text)
		}
	}
	return result, nil
}

// CreateNetwork 创建自定义网络(沙箱 restricted 档的隔离网络)。internal=true 时无外网出口。
func (a *DockerAdapter) CreateNetwork(name string, internal bool, labels map[string]string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("name is required")
	}
	ctx, cancel := dockerAPIContext()
	defer cancel()
	resp, err := a.cli.NetworkCreate(ctx, name, network.CreateOptions{
		Driver:   "bridge",
		Internal: internal,
		Labels:   labels,
	})
	if err != nil {
		return "", fmt.Errorf("create network: %w", err)
	}
	return resp.ID, nil
}
