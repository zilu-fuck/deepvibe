.PHONY: build build-server test

GO ?= go

build:
	$(GO) build -o bin/deepvibe ./cmd/deepvibe

build-server:
	$(GO) build -o bin/deepvibe-server ./cmd/deepvibe-server

test:
	$(GO) test ./...
