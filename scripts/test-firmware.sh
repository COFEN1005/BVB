#!/bin/sh
set -eu
node tests/firmware-fixtures.js
${CXX:-g++} -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -g tests/firmware.test.cpp -o .build/firmware-test
.build/firmware-test
