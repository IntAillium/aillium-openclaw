{
  "targets": [
    {
      "target_name": "openclaw_windows_job_object",
      "sources": ["src/addon.cc"],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20"],
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
