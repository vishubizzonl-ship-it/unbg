# preview-site — bani hui site (build output)

Ye branch **source nahi** hai, sirf ready-to-serve build hai — phone par npm ki
zaroorat na pade, isliye.

Phone par:

```bash
pkg install -y git python
git clone -b preview-site --depth 1 https://github.com/vishubizzonl-ship-it/unbg.git ~/site
cd ~/site && python3 -m http.server 4321
# Chrome: http://127.0.0.1:4321
```

Model list me "Server · BiRefNet General" chuno, URL box me
`http://127.0.0.1:8123` daalo (jo phone_server.py chala raha hai).

Note: on-device (browser) models ke WASM files is build me nahi hain — 49 MB
bachane ke liye. Server wala rasta poora chalta hai.
