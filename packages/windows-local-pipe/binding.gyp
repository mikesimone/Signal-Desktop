{
  "conditions": [
    ["OS=='win'", {
      "targets": [{
        "target_name": "windows-local-pipe",
        "dependencies": [
          "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
        ],
        "sources": [
          "addon.cpp",
        ],
        "libraries": [
          "advapi32.lib",
        ],
        "defines": [
          "UNICODE",
          "_UNICODE",
          "WIN32_LEAN_AND_MEAN",
          "NOMINMAX",
        ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1, # /EHsc,
            "RuntimeLibrary": "2", # /MD
          },
        },
      }],
    }, {
      "targets": [{
        "target_name": "noop",
        "type": "none",
      }],
    }],
  ],
}
