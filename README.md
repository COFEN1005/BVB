# iPhone BLE Voice Bridge

iPhoneの標準キーボードで音声入力した文章を、Web BluetoothでESP32-S3へ送信する静的Webアプリです。

## iPhoneでの利用

SafariはWeb Bluetoothに対応していないため、Bluefy Web BLE BrowserでRenderのHTTPS URLを開きます。

1. ESP32-S3の対応ファームウェアを起動
2. Bluefyでこのサイトを開く
3. `ESP32に接続` をタップ
4. `ESP32 Voice Bridge` を選択
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
