package adapters

import (
	"archive/tar"
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/docker/go-connections/nat"
)

func TestBuildContainerConfigsFullSpec(t *testing.T) {
	spec := &CreateContainerSpec{
		Name:           "sandbox-1",
		Image:          "starhub-sandbox:latest",
		Cmd:            []string{"/start.sh"},
		Env:            []string{"RESOLUTION=1920x1080"},
		Labels:         map[string]string{"starhub.sandbox": "true"},
		MemoryMB:       2048,
		CPUCores:       1.5,
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw"},
		Binds:          []string{"/host/exchange:/exchange"},
		NetworkMode:    "starhub-restricted",
		Ports: []PortBindingSpec{
			{ContainerPort: 6080},
			{ContainerPort: 5900, Protocol: "tcp", HostIP: "0.0.0.0", HostPort: 15900},
		},
	}

	cfg, host, err := buildContainerConfigs(spec)
	if err != nil {
		t.Fatalf("buildContainerConfigs: %v", err)
	}

	if cfg.Image != spec.Image || cfg.WorkingDir != "" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
	if _, ok := cfg.ExposedPorts[nat.Port("6080/tcp")]; !ok {
		t.Fatalf("missing exposed port: %#v", cfg.ExposedPorts)
	}
	// 默认回环发布,不暴露到局域网
	binding := host.PortBindings[nat.Port("6080/tcp")]
	if len(binding) != 1 || binding[0].HostIP != "127.0.0.1" || binding[0].HostPort != "0" {
		t.Fatalf("unexpected default binding: %#v", binding)
	}
	explicit := host.PortBindings[nat.Port("5900/tcp")]
	if len(explicit) != 1 || explicit[0].HostIP != "0.0.0.0" || explicit[0].HostPort != "15900" {
		t.Fatalf("unexpected explicit binding: %#v", explicit)
	}
	if host.Memory != 2048<<20 {
		t.Fatalf("memory: got %d", host.Memory)
	}
	if host.NanoCPUs != 1500000000 {
		t.Fatalf("nanoCpus: got %d", host.NanoCPUs)
	}
	if host.NetworkMode != "starhub-restricted" {
		t.Fatalf("networkMode: got %q", host.NetworkMode)
	}
	if !host.ReadonlyRootfs || len(host.CapDrop) != 1 || host.Tmpfs["/tmp"] != "rw" {
		t.Fatalf("unexpected host config: %#v", host)
	}
}

func TestBuildContainerConfigsDefaultsAndErrors(t *testing.T) {
	if _, _, err := buildContainerConfigs(&CreateContainerSpec{}); err == nil {
		t.Fatal("empty image should fail")
	}
	if _, _, err := buildContainerConfigs(&CreateContainerSpec{
		Image: "img",
		Ports: []PortBindingSpec{{ContainerPort: 0}},
	}); err == nil {
		t.Fatal("invalid containerPort should fail")
	}
	if _, _, err := buildContainerConfigs(&CreateContainerSpec{
		Image: "img",
		Ports: []PortBindingSpec{{ContainerPort: 80, HostPort: 70000}},
	}); err == nil {
		t.Fatal("invalid hostPort should fail")
	}

	cfg, host, err := buildContainerConfigs(&CreateContainerSpec{Image: "img"})
	if err != nil {
		t.Fatalf("minimal spec: %v", err)
	}
	if cfg.ExposedPorts != nil || host.PortBindings != nil {
		t.Fatal("no ports should leave maps nil")
	}
	if host.Memory != 0 || host.NanoCPUs != 0 {
		t.Fatal("zero limits should stay zero (unlimited)")
	}
}

func TestFilesTarRoundtrip(t *testing.T) {
	files := []CopyFileEntry{
		{Name: "a.txt", Content: base64.StdEncoding.EncodeToString([]byte("hello"))},
		{Name: "dir/b.sh", Mode: 0o755, Content: base64.StdEncoding.EncodeToString([]byte("#!/bin/sh\n"))},
	}
	buf, err := buildFilesTar(files)
	if err != nil {
		t.Fatalf("buildFilesTar: %v", err)
	}

	name, data, err := extractSingleFileFromTar(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if name != "a.txt" || string(data) != "hello" {
		t.Fatalf("unexpected first file: %s %q", name, data)
	}

	// 第二个文件也在包里
	tr := tar.NewReader(bytes.NewReader(buf.Bytes()))
	names := []string{}
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, hdr.Name)
	}
	if len(names) != 2 || names[1] != "dir/b.sh" {
		t.Fatalf("unexpected tar entries: %v", names)
	}
}

func TestBuildFilesTarErrors(t *testing.T) {
	if _, err := buildFilesTar(nil); err == nil {
		t.Fatal("empty files should fail")
	}
	if _, err := buildFilesTar([]CopyFileEntry{{Name: "", Content: ""}}); err == nil {
		t.Fatal("empty name should fail")
	}
	if _, err := buildFilesTar([]CopyFileEntry{{Name: "x", Content: "!!!not-base64!!!"}}); err == nil {
		t.Fatal("invalid base64 should fail")
	}
}

func TestBuildDockerfileTarAndParseStreamLine(t *testing.T) {
	if _, err := buildDockerfileTar("  \n"); err == nil {
		t.Fatal("empty dockerfile should fail")
	}
	buf, err := buildDockerfileTar("FROM ubuntu:24.04\n")
	if err != nil {
		t.Fatalf("buildDockerfileTar: %v", err)
	}
	tr := tar.NewReader(bytes.NewReader(buf.Bytes()))
	hdr, err := tr.Next()
	if err != nil || hdr.Name != "Dockerfile" {
		t.Fatalf("unexpected tar: %v %#v", err, hdr)
	}

	text, imageID, err := parseBuildStreamLine([]byte(`{"stream":"Step 1/2 : FROM ubuntu:24.04\n"}`))
	if err != nil || imageID != "" || !strings.HasPrefix(text, "Step 1/2") {
		t.Fatalf("stream line: %q %q %v", text, imageID, err)
	}
	_, imageID, err = parseBuildStreamLine([]byte(`{"aux":{"ID":"sha256:abc"}}`))
	if err != nil || imageID != "sha256:abc" {
		t.Fatalf("aux line: %q %v", imageID, err)
	}
	if _, _, err = parseBuildStreamLine([]byte(`{"errorDetail":{"message":"boom"},"error":"boom"}`)); err == nil {
		t.Fatal("error line should fail")
	}
	if _, _, err = parseBuildStreamLine([]byte(`not json`)); err == nil {
		t.Fatal("invalid json should fail")
	}
}
