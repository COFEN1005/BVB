#!/bin/sh
set -eu
cli=${ARDUINO_CLI:-arduino-cli}
# Keep the installed core and board aligned with the documented handoff target.
"$cli" core list --format json | python3 -c '
import json, sys
data = json.load(sys.stdin)
if not any(p.get("id") == "esp32:esp32" and p.get("installed_version") == "3.3.12"
           for p in data.get("platforms", [])):
    sys.exit("Install Arduino-ESP32 3.3.12 before building (see README).")
'
"$cli" compile --fqbn esp32:esp32:ozobot_drvkit:USBMode=default,PartitionScheme=default \
  --warnings all --build-path .build/ozobot-drvkit firmware/BVB_ESP32S3
