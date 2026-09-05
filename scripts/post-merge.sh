#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm run storyhold:schema:development
