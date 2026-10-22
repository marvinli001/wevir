// Emits snow-format vectors for Noise_XXpsk2 / Noise_IK with fixed keys, using the independent Rust implementation
// snow =0.10.0 (Cargo.toml next to this file). Run `cargo run --release > out.json`; ../snow-generated.json keeps the
// SHA256 entries of that output unchanged. CI only reads the JSON and does not need Rust.
fn h(b: &[u8]) -> String { hex::encode(b) }
fn main() {
    let ik = hex::decode("e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1").unwrap();
    let ie = hex::decode("893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a").unwrap();
    let rk = hex::decode("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893").unwrap();
    let re = hex::decode("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b").unwrap();
    let psk: [u8; 32] = hex::decode("54686973206973206d7920417573747269616e20706572737065637469766521").unwrap().try_into().unwrap();
    let prologue = b"wevir-pair-v1".to_vec();
    let payloads: Vec<Vec<u8>> = ["hello", "", "device:iPhone", "{\"jsonrpc\":\"2.0\"}", "ack", "x".repeat(300).as_str()]
        .iter().map(|s| s.as_bytes().to_vec()).collect();
    let mut out = vec![];
    for hash in ["SHA256", "BLAKE2s", "BLAKE2b", "SHA512"] {
        for pat in ["XXpsk2", "IK"] {
            let name = format!("Noise_{}_25519_ChaChaPoly_{}", pat, hash);
            let mut bi = snow::Builder::new(name.parse().unwrap()).local_private_key(&ik).unwrap().prologue(&prologue).unwrap().fixed_ephemeral_key_for_testing_only(&ie);
            let mut br = snow::Builder::new(name.parse().unwrap()).local_private_key(&rk).unwrap().prologue(&prologue).unwrap().fixed_ephemeral_key_for_testing_only(&re);
            if pat == "XXpsk2" { bi = bi.psk(2, &psk).unwrap(); br = br.psk(2, &psk).unwrap(); }
            // responder public key for IK
            let rpub_bytes = {
                use snow::resolvers::{CryptoResolver, DefaultResolver};
                let mut dh = DefaultResolver.resolve_dh(&snow::params::DHChoice::Curve25519).unwrap();
                dh.set(&rk); dh.pubkey().to_vec()
            };
            if pat == "IK" { bi = bi.remote_public_key(&rpub_bytes).unwrap(); }
            let mut io = Some(bi.build_initiator().unwrap());
            let mut ro = Some(br.build_responder().unwrap());
            let mut msgs = vec![];
            let mut buf = vec![0u8; 65535]; let mut buf2 = vec![0u8; 65535];
            let mut it = None; let mut rt = None;
            for (n, p) in payloads.iter().enumerate() {
                let from_i = n % 2 == 0;
                let len;
                if io.is_some() && !io.as_ref().unwrap().is_handshake_finished() {
                    let (i, r) = (io.as_mut().unwrap(), ro.as_mut().unwrap());
                    let (a, b) = if from_i { (i, r) } else { (r, i) };
                    len = a.write_message(p, &mut buf).unwrap();
                    let l2 = b.read_message(&buf[..len], &mut buf2).unwrap();
                    assert_eq!(&buf2[..l2], &p[..]);
                } else {
                    if it.is_none() {
                        let i = io.take().unwrap();
                        let hh = i.get_handshake_hash().to_vec();
                        it = Some((i.into_transport_mode().unwrap(), hh));
                        rt = Some(ro.take().unwrap().into_transport_mode().unwrap());
                    }
                    let (ti, tr) = (&mut it.as_mut().unwrap().0, rt.as_mut().unwrap());
                    if from_i { len = ti.write_message(p, &mut buf).unwrap(); tr.read_message(&buf[..len], &mut buf2).unwrap(); }
                    else { len = tr.write_message(p, &mut buf).unwrap(); ti.read_message(&buf[..len], &mut buf2).unwrap(); }
                }
                msgs.push(format!("{{\"payload\":\"{}\",\"ciphertext\":\"{}\"}}", h(p), h(&buf[..len])));
            }
            let hh = &it.as_ref().unwrap().1;
            let psks = if pat == "XXpsk2" { format!("[\"{}\"]", h(&psk)) } else { "[]".into() };
            let irs = if pat == "IK" { format!(",\"init_remote_static\":\"{}\"", h(&rpub_bytes)) } else { String::new() };
            out.push(format!("{{\"protocol_name\":\"{}\",\"init_prologue\":\"{}\",\"init_psks\":{},\"init_static\":\"{}\",\"init_ephemeral\":\"{}\"{},\"resp_prologue\":\"{}\",\"resp_psks\":{},\"resp_static\":\"{}\",\"resp_ephemeral\":\"{}\",\"handshake_hash\":\"{}\",\"messages\":[{}]}}",
                name, h(&prologue), psks, h(&ik), h(&ie), irs, h(&prologue), psks, h(&rk), h(&re), h(hh), msgs.join(",")));
        }
    }
    println!("{{\"vectors\":[{}]}}", out.join(","));
}
