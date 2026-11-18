#!/bin/sh
set -eu
cli=${ARDUINO_CLI:-arduino-cli}
"$cli" compile --fqbn esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=default,PartitionScheme=default \
  --warnings all --build-path .build/esp32s3 firmware/BVB_ESP32S3
