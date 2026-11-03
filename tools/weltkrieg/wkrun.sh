#!/bin/bash
# Lokal: wkrun.sh [--identity JSON] funktion JSON  -> /root/wkrun auf dem Server
ssh root@62.108.44.118 "/root/wkrun $(printf '%q ' "$@") 2>/dev/null"
