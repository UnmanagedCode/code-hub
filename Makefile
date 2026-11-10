# Host relay for code-hub in Docker: see docs/host-relay.md.
PYTHON ?= python3
ARGS ?=

# Directory of this Makefile (with trailing slash), so `make -C <checkout> relay` works from anywhere.
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := help
.PHONY: help relay

help:
	@echo "Targets:"
	@echo "  relay   run the host relay (relay/relay.py) in the foreground"
	@echo "  help    show this list"
	@echo ""
	@echo "Variables:"
	@echo "  PYTHON  interpreter to run relay.py with, e.g. PYTHON=python3.11"
	@echo "  ARGS    extra arguments passed verbatim to relay.py, e.g. ARGS=\"--advertise 192.168.1.10\""

relay:
	$(PYTHON) "$(ROOT)relay/relay.py" $(ARGS)
