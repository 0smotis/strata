// Copy the browser runtime files the app needs from node_modules into src/vendor
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'src', 'vendor');
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(path.join(root, 'node_modules', from), path.join(out, to)); };
copy('ag-psd/dist/bundle.js', 'ag-psd.js');
for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) copy('@huggingface/transformers/dist/' + f, 'transformers/' + f);
for (const f of ['ort.all.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copy('onnxruntime-web/dist/' + f, 'ort/' + f);
copy('gifenc/dist/gifenc.esm.js', 'gifenc.js');
console.log('vendor files copied');
