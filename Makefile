SHELL := /bin/bash

proposals-list:
	./infra/rpc.sh tools/proposals/list '{"limit":5}'

propose-approve:
	@if [ -z "$(TOOL)" ] || [ -z "$(ARGS)" ]; then \
		echo "Usage: make propose-approve TOOL=tasks_create ARGS='{\"title\":\"Test\",\"dueDateTime\":\"2026-02-19T17:00:00-05:00\",\"contactId\":\"CONTACT_ID\"}'"; \
		exit 1; \
	fi
	./infra/propose_approve.sh "$(TOOL)" '$(ARGS)'
