# iPhone BLE Voice Bridge

iPhoneの標準キーボードで音声入力した文章を、Web BluetoothでESP32-S3へ送信する静的Webアプリです。

## iPhoneでの利用

SafariはWeb Bluetoothに対応していないため、Bluefy Web BLE BrowserでRenderのHTTPS URLを開きます。

1. ESP32-S3の対応ファームウェアを起動
2. Bluefyでこのサイトを開く
3. `ESP32に接続` をタップ
4. `ESP-BVB Bridge` を選択（iPhoneのBluetooth設定ではペアリングしない）
5. 入力欄でiPhone標準キーボードの音声入力を使用
6. `PCへ送信` をタップ

## BLE UUID

- Service: `7f510001-6f3b-4f37-9d9a-6c7f5f11b001`
- Write: `7f510002-6f3b-4f37-9d9a-6c7f5f11b001`
- Status/Notify: `7f510003-6f3b-4f37-9d9a-6c7f5f11b001`

## Render

`render.yaml`をBlueprintとして読み込むか、Static Siteとして以下を指定します。

- Build Command: 空欄
- Publish Directory: `dist`

## ESP32-S3 firmware

Arduino IDEで `firmware/BVB_ESP32S3/BVB_ESP32S3.ino` を開きます。

- Board: 使用中のESP32-S3ボード（例: Ozobot DRVKit）
- USB Mode: `USB-OTG (TinyUSB)`
- Flash Size / Partition: ボード既定値で可
- PC接続: ESP32-S3のネイティブUSB端子を使用

ファームウェアはBLE GATTでWebページから文章を受信し、PCへUSB HIDキーボード入力します。BLE側にキーボード機能はありません。現段階のPC出力はASCII英数字・記号に対応し、日本語UTF-8は文字化け防止のため明示的に拒否します。
