# Android sample (OkHttp)

Use OkHttp or Retrofit to POST the device JSON to `/device/register`.

Example using OkHttp:

```java
OkHttpClient client = new OkHttpClient();

MediaType JSON = MediaType.get("application/json; charset=utf-8");
String url = "https://bengal-tiger-admin-production-8071.up.railway.app/device/register";

JSONObject body = new JSONObject();
body.put("deviceId", deviceId);
body.put("serialNumber", serialNumber);
body.put("model", Build.MODEL);
body.put("androidVersion", Build.VERSION.RELEASE);
body.put("sim1", sim1Number);
body.put("battery", batteryLevel);
body.put("isOnline", true);
body.put("lastSeen", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").format(new Date()));

RequestBody requestBody = RequestBody.create(body.toString(), JSON);
Request request = new Request.Builder().url(url).post(requestBody).build();

client.newCall(request).enqueue(new Callback() {
  @Override public void onFailure(Call call, IOException e) {
    e.printStackTrace();
  }
  @Override public void onResponse(Call call, Response response) throws IOException {
    if (response.isSuccessful()) {
      // success
    }
  }
});
```

Send this periodically (e.g., every 30–60 seconds) to act as a heartbeat.
