# Wire fixture provenance

- `cau-login.bin`: CAU OZJSViewer guest login capture, 2026-10-06. No user credentials or session token; guest/guest and initial session -1905.
- `cau-data.bin`: same capture, 2026 S / campus 1 / sust 3B410 / 15841-01. Repository session replaced by `fixture-session`, employee parameter cleared. No response rows, contact details or cookies. Original body was 660 bytes; sanitized body is 658 bytes. Field order and trailer remain captured values.
- `ozra-empty-v1.bin`: adapted from OZRA `build_empty_data_module_response` in `src/messages/data_module.rs`, commit `9c6da3b9ab1169c3ac0b136625234e0d3553d07a`. Only message class changed from `EmptyDataModule` to the actual response class required by this client. Version byte 1, empty group, field schema and internal key `ds0` are preserved. MIT, Copyright (c) 2023-2026 Koo Hyomin; see `third-party/ozra-LICENSE.txt`.

CAU requests use 17 header fields, `rv=268435456`, `fd=''`, compact bodies and a `[2,32,17,0,0]` trailer.
