# Liminal audio source-separation models — research note

**Date:** 2026-09-17  
**Scope:** Whether/how to include **AudioSep** (or newer alternatives) in **NoDAW Liminal StemSplit**.  
**Method:** Local inventory of Liminal + Master Studio adapters, then primary papers/repos. Benchmarks are **cited, not invented**. Anecdotal items are labeled.

**Better home for this note:**  
Canonical Liminal product tree is `D:\Projects\Liminal-StemSplit\` (desktop engine at `stemsplit-desktop_app\StemSplit1-main\`). This file was written under `nodaw-audiorescue` as requested; copy or move to `D:\Projects\Liminal-StemSplit\docs\research\` if you want it next to the product.

---

## Executive recommendation (one paragraph)

**Do not add AudioSep as a default music-stem engine.** Liminal already ships the 2025–2026 music SOTA stack (MelBand / BS-RoFormer, PolarFormer, SCNet XL IHF, jarredou BS-RoFormer-SW 6-stem) via `python-audio-separator` + ZFTurbo MSST. AudioSep is a **language-queried open-domain** model (CLAP + ResUNet, **32 kHz mono**). It is useful as an **optional “separate anything you type”** Pro experiment, not as a replacement for RoFormer. For query-mode, AudioSep is still the most **packable MIT** LASS model; **SAM Audio** (Meta, Dec 2025) is the quality/capability jump but sits on the **SAM License + gated weights** and is a generative flow model (hallucination risk). **FlowSep / FlowSep2** beat AudioSep on LASS metrics in papers, but are not product-ready for a Windows desktop ship.

**Top 3 picks for Liminal (by job):**

1. **Music quality / 2–6 stems:** MelBand RoFormer (Kim) + BS-RoFormer-SW 6-stem + SCNet XL IHF (already in catalog).  
2. **Elaborate splits:** keep DrumSep + instrument extractors; prototype **ZFTurbo Mega 53** only as an optional 16 GB+ payload.  
3. **Query / dialogue / “anything”:** prototype **AudioSep** (MIT, fast, mature) first; **BandIt Plus** for speech/music/FX; **SAM Audio** only after legal review.

**Next experiment (one week):** A/B on 8–12 real Liminal tracks: (a) current default vs MelBand Kim vs BS-RoFormer-SW 6s vs SCNet XL IHF; (b) AudioSep text queries (`vocals`, `lead guitar`, `crowd`, `dialogue`) vs those same stems from RoFormer. Score bleed/artifacts by ear + optional SDR on any isolated references. Gate AudioSep behind an Experimental toggle if it wins *query* cases only.

---

## 1. What Liminal is on this machine

### Identity

| Item | Value |
|------|--------|
| Product | **NoDAW™ Liminal™ StemSplit** — local-first stem splitter, one-time purchase (~$49) |
| Canonical repo | `D:\Projects\Liminal-StemSplit\` |
| Desktop source (v0.5.0) | `D:\Projects\Liminal-StemSplit\stemsplit-desktop_app\StemSplit1-main\` |
| Stack | Tauri 2 + Next.js 16 + React 18 + **embedded Python 3.10** |
| Latest packaged | **v0.5.0** (Windows installer 2026-08-02) |
| PRO install on this PC | still **v0.4.7** at `D:\Liminal\NoDAW Liminal\` (progress report 2026-08-07) |
| FREE install | v0.5.0 at `D:\Liminal\FREE\NoDAWLiminal\` |
| Ecosystem | Master Studio salvage spine: “stems Liminal/Demucs/UVR” (`nodaw-creation-suite-master-studio` memory). ACE-Step UI `stem_split_engine.py` shells Demucs + UVR/MDX from `D:\AudioSeperationModels`. |

`nodaw-audiorescue` (`C:\Users\Gaming\Projects\nodaw-audiorescue`) is the **Cloudflare AudioRescue** site, not the separator. Liminal ownership is the StemSplit repo.

### Current separation stack (code, not marketing)

Runtime (`requirements.txt`): `torch==2.8.0`, `demucs==4.0.1`, `spleeter==2.4.2` + TF CPU, `audio-separator[cpu]`, whisper, yt-dlp, pedalboard.

Routing is `scripts/model_registry.py` + `scripts/splitter.py`:

| Backend | What it is | Catalog examples |
|---------|------------|------------------|
| `demucs` | Facebook HTDemucs v4 CLI | `htdemucs`, `htdemucs_ft`, `htdemucs_6s` |
| `audio_separator` | [nomadkaraoke/python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) (MIT, v0.47.0 as of 2026-08-27) | MDX ONNX, VR `.pth`, RoFormer `.ckpt`, karaoke, crowd, dereverb |
| `mvsep` | Bundled `MVSEP-MDX23-music-separation-model-main` | `mdx23_ensemble` |
| `ensemble` | audio-separator presets | `vocal_balanced`, karaoke, instrumental |
| `spleeter` | Deezer 2-stem fast path | `spleeter_2` |
| `drumsep` / MDX23C | kick/snare/toms/hh/ride/crash | `drumsep_mdx23c_6` |
| MSST (ZFTurbo) | used when audio-separator cannot load architecture (htdemucs ckpt, **SCNet**) | `scnet_xl_ihf`, etc. |

**Already in the 0.5.0 catalog (not vapor):** MelBand RoFormer (Kim), BS-RoFormer ep317/ep368, PolarFormer, HyperACE v2, **BS-RoFormer-SW 6-stem** (vocals/bass/drums/guitar/piano/other), SCNet XL / XL IHF, guitar (becruily MelBand), choir male/female, woodwinds VR, crowd, karaoke, de-echo/dereverb/denoise.

**AudioSep is not referenced** in Liminal Python/TS catalogs.

Models live under `%LOCALAPPDATA%\StemSplit\models` with legacy roots `D:\AudioSeperationModels` and `D:\Ultimate Vocal Remover`. Hardware brain on this box: **8.0 GB VRAM CUDA**, “fast” split strategy (`hardware_config.json`).

### Local smoke (v0.4.7 suite, 15 s clip, 2026-06-10)

From `model_inference_tests_v047/RESULTS.md` — **timings only, not SDR**:

| Model | Engine | Stems | Seconds |
|-------|--------|------:|--------:|
| `vr_hp_vocal_4` | vr | 1 | 11.7 |
| `roformer_polarformer` | roformer | 2 | 14.7 |
| `roformer_melband` | roformer | 1 | 15.5 |
| `drumsep_mdx23c_6` | drumsep | 5 | 15.9 |
| `roformer_bs_368` | roformer | 2 | 16.6 |
| `spleeter_2` | spleeter | 2 | 28.6 |
| `demucs_htdemucs` | demucs | 2 | 30.2 |
| `roformer_bs_sw_6s` | roformer | 6 | 37.7 |
| `mdx23_ensemble` | mdx | 2 | 65.2 |
| `karaoke_mvsep_team` | ensemble | 2 | 125.5 |

Failed: `ensemble_vocal_balanced` (tensor size), `mdx_kim_vocal_2` (protobuf import). Progress report still flags these as the last full inference suite.

---

## 2. AudioSep (paper + repo, status 2025–2026)

### What it is

- Paper: Liu et al., *Separate Anything You Describe*, [arXiv:2308.05037](https://arxiv.org/abs/2308.05037) (v3 2024-12-01; IEEE TASLP 2025, vol. 33, pp. 458–471).
- Official repo: [Audio-AGI/AudioSep](https://github.com/Audio-AGI/AudioSep) — **MIT**, ~1.9k stars, **62 commits**, Windows `environment_win64.yaml` exists.
- Task: **LASS** — extract **one target** from a mixture given a **natural-language query**. Not a fixed 4-stem mixer.
- Architecture: **QueryNet** = CLIP or **CLAP** text encoder; **SeparationNet** = frequency-domain **ResUNet30** (mask). Trained on ~**14,000 hours** of multimodal data (Wang CCF keynote, Dec 2024).
- Sample rate: **32 kHz**, STFT 2048 / hop 320. Config: `input_channels: 1` / `output_channels: 1` → **mono**.
- Checkpoint: `audiosep_base_4M_steps.ckpt` ([HF Space](https://huggingface.co/spaces/Audio-AGI/AudioSep), also `nielsr/audiosep-demo`). DCASE 16 kHz baseline weights: **1.2 GB** ([Zenodo](https://zenodo.org/records/10887460)).
- Deps: **PyTorch + pytorch-lightning**, conda env, CLAP weights. Inference API is a few lines (`pipeline.build_audiosep` + `inference(..., use_chunk=True)`).
- Maturity: research-complete, Colab/HF/Replicate exist. Repo is largely frozen after 2023–2024 training/eval release. DCASE 2024 Task 9 **baseline is AudioSep**. Not a maintained product SDK like `audio-separator`.

### Quality (published, LASS datasets — **not MUSDB 4-stem**)

From the official README / paper:

| Dataset | Avg SDRi | SI-SDR |
|---------|---------:|-------:|
| VGGSound | 9.144 | 9.043 |
| MUSIC (instruments) | 10.508 | 9.425 |
| ESC-50 | 10.040 | 8.810 |
| AudioSet (527 classes) | 7.739 | 6.903 |
| AudioCaps | 8.220 | 7.189 |
| Clotho | 6.850 | 5.242 |

Paper also reports DCASE 2024 T9 **8.16 dB SDRi** for the large AudioSep (distinct from the *challenge baseline* trained only on Clotho+FSD50K). Voicebank-Demand SSNR **9.21 dB**.

**DCASE 2024 Task 9** ([results](https://dcase.community/challenge2024/task-language-queried-audio-source-separation-results)):

- Baseline (AudioSep 16 kHz, 200k steps): **SDR 5.708** (val synth).
- Winner Kim_GIST-AunionAI: **SDR 8.869** eval / subjective 3.310. Several top systems **fine-tuned or wrapped AudioSep-32K** + LLM caption augmentation.

These numbers measure **open-domain event isolation**, not “vocals vs instrumental on a pop mix.” Comparing them to MelBand’s Multisong vocal SDR (~11 dB) is apples-to-oranges.

### Speed

FlowSep authors (Yuan et al.; numbers recapitulated in secondary writeups of the ICASSP 2025 paper) report **~0.06 s** GPU inference for AudioSep vs **~0.58 s** FlowSep (10 RFM steps) vs **~18 s** diffusion. Relative: AudioSep is a **single-pass masker** — near-real-time on GPU for short clips; CPU is heavier but still one forward pass. Not a 4-stem RoFormer.

### License / commercial

- Code: **MIT** (Copyright Xubo Liu).
- Weights: released on HF/Zenodo without a separate non-commercial clause found in the repo README. **Still verify CLAP checkpoint license** (LAION-CLAP is Apache-2.0-style open research; bundled CLAP files in AudioSep need a lawyer pass before shipping inside a paid installer).
- Training data includes AudioSet / VGGSound / captions — typical research-data residue; same class of risk as every UVR community weight.

### Fit for Liminal

| Pros | Cons |
|------|------|
| Unique **text query** UX Liminal does not have | **Mono 32 kHz** — wrong default for stereo music stems |
| MIT, small-ish API, Windows conda file | Does **not** beat RoFormer on MUSDB-style vocals (no such claim) |
| Fast vs generative LASS | Hallucinated/wrong-source risk when query is vague |
| Dialogue/SFX/crowd/“the snare only” queries | Extra PyTorch+CLAP payload; not in `audio-separator` |
| DCASE-proven | Repo maintenance is slow |

**Verdict:** Worth a **gated Experimental “Query split”** prototype. **Not** worth replacing MelBand / BS-RoFormer-SW / SCNet.

---

## 3. Competing / newer models (mid–late 2026 evidence)

### 3.1 Music stem separators (Liminal’s core job)

**Demucs / HDemucs / HTDemucs (v4)**  
- Paper: Rouard, Massa, Défossez, *Hybrid Transformers for Music Source Separation*, ICASSP 2023. Official: **9.00 dB** MUSDB HQ average; **9.20 dB** with sparse attention + per-source FT ([Meta](https://research.facebook.com/publications/hybrid-transformers-for-music-source-separation/); [adefossez/demucs](https://github.com/adefossez/demucs) MIT **code**).  
- Stems: 4 (`htdemucs` / `_ft`) or 6 (`htdemucs_6s` — guitar/piano; authors warn piano is weak).  
- **Weights license concern:** maintainer in [facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327) (2022-05-23): *“The model weights are not covered by the MIT license, and are provided only for scientific purposes.”* No later superseding grant found. Conservative commercial reading: **do not default-ship Meta checkpoints** in a paid product. Liminal already uses them as a workhorse — treat as **fallback / user-downloaded**, not as the advertised SOTA.  
- Speed: Liminal 15 s clip ~30 s on this 8 GB GPU (2-stem path). Still the most packaged 4-stem CLI.

**MDX-Net / UVR / MDX23C**  
- KUIELab MDX-Net + Anjok07/aufr33 UVR zoo. Liminal already has Kim Vocal 2, Inst HQ 1–5, karaoke, crowd, MDX23C HQ.  
- ZFTurbo Multisong: MDX23C vocals **10.17** SDR; Kim/MDX remain strong ONNX (DirectML-friendly) options.  
- `python-audio-separator` is the maintained packaging layer (MIT).

**BS-RoFormer / Mel-Band RoFormer**  
- ByteDance: Lu/Wang/Kong/Hung, *Music Source Separation with Band-Split RoPE Transformer*, [arXiv:2309.02612](https://arxiv.org/abs/2309.02612). Smaller model **9.80 dB** MUSDB average without extra data; SDX’23 system **~11.99 dB** with extra songs (workshop abstract).  
- Open reimplementation: [lucidrains/BS-RoFormer](https://github.com/lucidrains/BS-RoFormer) **MIT**. Community weights via ZFTurbo / TRvlvr / Kimberley Jensen.  
- ZFTurbo **Multisong vocals** ([pretrained_models.md](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md)): MelBand Kim **10.98**, BS PolarFormer **11.00**, BS RoFormer viperx **10.87**. Filename `sdr_12.9755` is **not** the same protocol as MUSDB test — do not quote it as MUSDB.  
- MUSDB-only 4-stem BS-RoFormer (ZFTurbo): avg **9.65**.  
- **BS-RoFormer-SW (jarredou)** 6-stem: already Liminal `roformer_bs_sw_6s`. Community/tooling (bs-roformer-infer 2026-07) calls it the default 6-stem. **Anecdotal** “best 6-stem as of Feb 2026” appears on secondary pages; treat as community consensus, not a paper table.  
- Native packaging path: [chenmozhijin/BSRoformer.cpp](https://github.com/chenmozhijin/BSRoformer.cpp) GGML/GGUF CPU+CUDA+Vulkan — future installer slimming.

**SCNet (Sparse Compression Network)**  
- ZFTurbo MUSDB test (MUSDB-only train): **SCNet XL IHF avg 10.08** (bass 9.23 / drums 11.81 / vocals 11.42 / other 7.88) vs HTDemucs-class ~9.x. **Fastest high-quality 4-stem architecture** in that table. Liminal already registers `scnet_xl_ihf` via MSST.  
- Sony MIMO ([SonyResearch/mimo-audio-separation](https://github.com/SonyResearch/mimo-audio-separation)) wraps BS-RoFormer / Mel-RoFormer / SCNet with iterative MIMO; extra quality, extra latency. Research-grade.

**Ensembles (MVSEP, 2025.06)**  
- [mvsep.com/algorithms](https://mvsep.com/zh/algorithms): Ensemble 2025.06 (BS RoFormer ×2 + MelBand FT + SCNet XL IHF) **vocals SDR 11.93 / instrumental 18.23** on Multisong. Highest quality, **slow**, VRAM-hungry. Liminal already has ensemble presets; `ensemble_vocal_balanced` **failed** the 0.4.7 smoke.

**ZFTurbo Mega 53 (2026-04-20)**  
- [MSST v1.0.21](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v1.0.21): 53 instrument/voice classes on BS-RoFormer. Author notes: **≥16 GB VRAM**, stems **do not sum to the mix**, per-stem quality **below specialists**, empty-stem filtering needed.  
- Code **MIT**. UnMixLabs claims Roman confirmed **weights MIT for commercial use on 2026-05-10** ([credits](https://www.unmixlabs.com/credits)) — **third-party correspondence, not a LICENSE file in the release**. Legal should keep that email/thread. **8 GB Liminal default cannot run this comfortably.**

**BandIt Plus**  
- Speech / music / effects on DnR: avg **11.50** (speech 15.64 / music 9.18 / effects 9.69) — [ZFTurbo table](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md). Best **podcast / dialogue vs music** open weight already in the same zoo Liminal uses.

### 3.2 Language-queried / “separate anything”

| Model | Year | Approach | Vs AudioSep | Product readiness |
|-------|------|----------|-------------|-------------------|
| **CLIPSep** ([sony/CLIPSep](https://github.com/sony/CLIPSep), ICLR 2023, MIT) | 2022–23 | CLIP image→text zero-shot | Weaker; AudioSep scaled data | Skip |
| **AudioSep** | 2023–25 | CLAP + ResUNet mask | Baseline LASS | Best packable LASS |
| **FlowSep** ([Audio-AGI/FlowSep](https://github.com/Audio-AGI/FlowSep), ICASSP 2025, [arXiv:2409.07614](https://arxiv.org/abs/2409.07614)) | 2024–25 | Rectified flow in VAE latent + FLAN-T5 + vocoder | Paper: better FAD/CLAPScore/REL/OVL; fewer spectral holes; **slower**; **generative** | 7 commits, “Evaluation coming soon”, AudioLDM+BigVGAN stack — **not shippable** |
| **Hybrid-Sep** [arXiv:2506.16833](https://arxiv.org/abs/2506.16833) | 2025-06 | SSL + CLAP + adversarial diffusion | Claims SOTA over AudioSep **and** FlowSep | Paper only (WASAA 2025) |
| **FlowSep 2** [arXiv:2608.22111](https://arxiv.org/abs/2608.22111) | 2026-08 | DiT + Self-Flow RFM | Claims SOTA LASS, overlapping events | **No product repo found at research time** |
| **UniSep** [arXiv:2503.23762](https://arxiv.org/abs/2503.23762) | 2025-03 | LLM-based universal sep | Fine-tuneable to LASS | Research |
| **SAM Audio** (Meta, Dec 2025, [arXiv:2512.18099](https://arxiv.org/abs/2512.18099), [blog](https://ai.meta.com/blog/sam-audio/)) | 2025–26 | Flow-matching transformer; **text + visual + time-span** prompts | Meta claims SOTA across general/speech/music vs prior general-purpose **and** specialists | Code public; **SAM License**; **gated HF**; Python ≥3.11; heavy deps (PE-AV, ImageBind, CLAP fork) |

**SAM License (2025-11-19):** royalty-free use/redistribute/derivatives **if** you pass the SAM License to users, obey trade controls, no reverse-engineering of internals, Meta may terminate/amend. **Not MIT.** HF is gated. Generative → **hallucinated stems**. Do not silently bundle in a $49 installer without counsel.

### 3.3 Speed / packaging extras

- **Spleeter**: Deezer; paper JOSS 2020 claims **~100× realtime 4-stem on GPU**; Liminal 2-stem ~29 s on 15 s clip (CPU/TF path — slow here). Code MIT; weights discussed as MIT in the paper; [issue #898](https://github.com/deezer/spleeter/issues/898) still asks for commercial confirmation. Deezer sells **Spleeter Pro**. Keep as **preview**, not quality flagship.  
- **audio-separator** DirectML: MDX/VR GPU; RoFormer often **CPU fallback** on DML (allocator OOM) — documented in their README. NVIDIA CUDA is Liminal’s real GPU path.  
- **BSRoformer.cpp**: future path to drop 276 MB Python payload for vocal-only SKUs.

---

## 4. Comparison table

**Legend:** Quality is **protocol-labeled**. Speed is relative on a ~8 GB NVIDIA box. “Commercial OK?” = **code + typical community reading of weights**; not legal advice.

| Model | Quality (cited) | Stems / query | Speed | VRAM/RAM | License | Windows packaging | Tooling |
|-------|-----------------|---------------|-------|----------|---------|-------------------|---------|
| **HTDemucs v4** | MUSDB ~**9.0–9.2** avg (paper) | 4 or 6 fixed | Med | ~4–6 GB | Code MIT; **weights “scientific only” (#327)** | Easy (`demucs` pip; already shipped) | Strong CLI; unmaintained |
| **Spleeter** | Old SOTA (~2019) | 2/4/5 | Fast (GPU paper); **slow in Liminal TF CPU** | Low | Code MIT; weights informal | Painful TF 2.12 on Win | Preview only |
| **MDX / UVR ONNX** | Multisong vocals ~**10.2** (MDX23C) | 2-stem + karaoke/crowd | Fast–med (ONNX) | Low–med | UVR MIT + credit (community) | **Best** ONNX/DirectML | audio-separator |
| **MelBand RoFormer (Kim)** | Multisong vocals **10.98** (ZFTurbo) | 2-stem vocals | Slow (Liminal 15.5 s / 15 s) | Med–high (ckpt GBs) | Arch MIT; community ckpt | Already in Liminal | audio-separator |
| **BS-RoFormer viperx** | Filename 12.97; Multisong **10.87** | 2-stem | Slow (16.6 s) | Med–high | Same | Already in Liminal | audio-separator |
| **PolarFormer** | Multisong vocals **11.00** | 2-stem | Slow (14.7 s) | Med | ZFTurbo MIT | Already in Liminal | MSST/audio-separator |
| **BS-RoFormer-SW** | Community 6-stem SOTA (**anecdotal** leaderboard) | **6** stems | Slow (37.7 s / 15 s) | High | Community ckpt; confirm per file | **Already wired** | audio-separator |
| **SCNet XL IHF** | MUSDB avg **10.08** (MUSDB-only) | 4-stem | Faster than RoFormer (arch claim) | Med | ZFTurbo MIT | In registry via MSST | ZFTurbo |
| **MVSEP ensemble 2025.06** | Multisong vox **11.93** / inst **18.23** | 2-stem | Very slow | High (12 GB+ in Liminal copy) | Mix of community | Fragile (`ensemble_vocal_balanced` failed smoke) | MVSEP |
| **DrumSep MDX23C** | DrumSep test kick **14.54** (aufr33/jarredou) | 6 drum mics | Fast (15.9 s) | Med | Community | Already in Liminal | audio-separator |
| **Mega 53** | Author: **below specialists** | **53** overlapping | Slow | **≥16 GB** | Code MIT; weights MIT **per UnMixLabs 2026-05-10 claim** | Poor on 8 GB | MSST |
| **BandIt Plus** | DnR avg **11.50** | speech/music/FX | Med | Med | ZFTurbo MIT | Not in Liminal UI yet | MSST |
| **AudioSep** | LASS SDRi **6.9–10.5** (open-domain); DCASE baseline **5.71** / large **~8.2** | **Text query**, 32 kHz **mono** | Fast (mask) | ~4–8 GB + 1.2 GB ckpt | **MIT** code | New conda/PyTorch stack | HF/Replicate; stale repo |
| **FlowSep / 2** | Paper: beats AudioSep FAD/CLAP | Text query, generative | 10×+ slower than AudioSep | High + vocoder | Research | Hard (AudioLDM/BigVGAN) | Immature |
| **SAM Audio** | Meta: SOTA general/speech/music (**their bench**) | Text / visual / time | Generative (not RT) | High; Py 3.11 | **SAM License**, gated | Hard (PE-AV, ImageBind) | Official demo; not drop-in |
| **CLIPSep** | Below AudioSep | Text via CLIP | Fast | Low | MIT | Skip | Stale |

---

## 5. Phased plan for Liminal

### Phase 0 — Do not regress (this week)

Keep as **fallback / fast path**:

- `htdemucs` 4-stem (document Meta weight caveat in About/credits).
- Spleeter or VR-HP for **preview**.
- Existing ONNX MDX for low-VRAM machines.

Fix the two known smoke fails (`ensemble_vocal_balanced`, `mdx_kim_vocal_2` protobuf) before adding engines.

Re-run `model_inference_tests_v047` on the **0.5.0** embedded Python.

### Phase 1 — Quality defaults (highest ROI; models already registered)

Change **defaults**, don’t add AudioSep:

| Job | Default now (typical) | Proposed default | Why |
|-----|----------------------|------------------|-----|
| Vocals / instrumental | HTDemucs or MDX | **MelBand RoFormer Kim** (`roformer_melband`) | Highest cited Multisong vocal SDR in the zoo Liminal already ships |
| 4-stem band | `htdemucs` | **SCNet XL IHF** if VRAM ≥8 GB else HTDemucs | MUSDB 10.08 vs ~9.0; faster class than RoFormer |
| 6-stem guitar/piano | `htdemucs_6s` | **`roformer_bs_sw_6s`** | Already S-tier in catalog; 37.7 s on 15 s clip is acceptable for Pro |
| Karaoke | MDX KARA | Keep + MelBand ensemble when fixed | |
| Drums explode | DrumSep MDX23C | Keep | |
| Podcast / dialogue | VR denoise | Add **BandIt Plus** | Only strong open speech/music/FX split |

UI: honest labels (“experimental”, “needs 8 GB”, “stems may not sum”).

### Phase 2 — AudioSep query prototype (1–2 weeks)

**Yes, include AudioSep — as a feature, not a replacement.**

1. Optional payload: `audiosep_base_4M_steps.ckpt` + CLAP (~1–2 GB), download on first use like other models.  
2. UI: single text box — “Extract: *lead vocal*, *acoustic guitar*, *crowd*, *siren*, *male speech*”. Output **one stem + residual**. Upsample/dither disclaimer: **32 kHz mono**.  
3. Test matrix vs RoFormer on: buried SFX, dialogue-under-music, “only snare”, “only crowd”.  
4. If query quality is merely “OK” and RoFormer already covers the query class, **don’t ship**. If it wins SFX/dialogue, ship as **Liminal Query (Experimental)**.

Do **not** start with FlowSep/FlowSep2/Hybrid-Sep — no Windows packaging story.

### Phase 3 — Elaborate splits (only if Phase 1 defaults land)

- Mega 53 as **optional 16 GB+ downloader**, never default on 8 GB. Filter empty stems; warn that stems overlap.  
- Guitar/piano specialists already in catalog (`inst_guitar_becruily`, SW extract) — surface them in Layer Peel, don’t hide behind 98-model soup.  
- Optional later: Sony MIMO iterative pass as “Ultra” (slow).

### Phase 4 — SAM Audio (legal + hybrid cloud)

Only after counsel reads **SAM License** + HF gate:

- Local: likely too heavy for 8 GB and Python 3.10 embed.  
- Hybrid: Pro “cloud query” hitting a self-hosted SAM worker, or wait for quantized community ports.  
- Always label **generative** output (possible invented notes/words).

### Phase 5 — Speed / installer

- Prefer ONNX MDX + quantized RoFormer (GGUF / `BSRoformer.cpp`) for Lite.  
- Keep full PyTorch RoFormer/SCNet for Pro.  
- Drop TF/Spleeter when a fast ONNX 2-stem exists.  
- One GPU job at a time (Master Studio already queues GPU=1).

### Whether AudioSep is “worth including”

| Question | Answer |
|----------|--------|
| Improve **music** vocal SDR vs MelBand/BS-RoFormer? | **No evidence.** Different task. |
| More **elaborate music stems**? | **No.** One query → one source. Use SW 6-stem / Mega 53. |
| Faster than RoFormer? | **Yes** (single mask pass), but at 32 kHz mono. |
| New capability Liminal lacks? | **Yes: arbitrary text query** (SFX, dialogue, “the dog”, “only hi-hat” when DrumSep fails). |
| Ship now as default? | **No.** |
| Prototype? | **Yes — Experimental Query.** |

### Risks

| Risk | Mitigation |
|------|------------|
| **Hallucinated stems** (FlowSep, SAM Audio, even mask models on bad queries) | Residual check, “does not sum” badge, never call generative output “stems” without a warning |
| **License** | Credits UI: MIT (AudioSep, MSST, audio-separator, lucidrains); Meta Demucs **weights scientific-only**; SAM License if used; UVR credit Anjok07/aufr33; Mega 53 keep ZFTurbo confirmation |
| **Weight hosting** | Don’t rehost TRvlvr-dead URLs; use ZFTurbo releases / Politrees mirrors / HF as Liminal already does. Pin hashes in `model_payload_manifest.json` |
| **8 GB VRAM** | Chunked inference (`use_chunk` on AudioSep; audio-separator overlap). No Mega 53 / fat ensembles as default |
| **Stereo / SR** | Never silently downsample a 44.1/48 k stereo master through AudioSep without an upsample + mono warning |
| **Maintenance** | Prefer engines already behind `audio-separator` / MSST. AudioSep is a **second runtime** — isolate it so torch/CLAP conflicts don’t break RoFormer |
| **Protobuf / ensemble bugs** | Fix before marketing “98 models” |

---

## 6. Suggested experiment card (next run)

**Name:** `liminal-sep-ab-2026-09`  
**Machine:** this 8 GB CUDA box, Liminal 0.5.0 embedded Python.  
**Material:** 8–12 tracks (pop, trap, live band, podcast+music, SFX bed).  
**A — music defaults:** `demucs_htdemucs` vs `roformer_melband` vs `roformer_bs_sw_6s` vs `scnet_xl_ihf` (where 4-stem). Metrics: listen (bleed, artifacts, stereo), wall time, peak VRAM. Optional museval if any track has refs.  
**B — query:** AudioSep prompts `vocals`, `drums`, `speech`, `crowd`, `electric guitar` vs the closest Liminal specialist.  
**Go/no-go:** Change default if A wins on ≥6/8 music tracks; ship Query if B wins on ≥3 non-music or “no specialist” cases without wrecking music.

---

## Sources (primary)

- AudioSep paper: https://arxiv.org/abs/2308.05037  
- AudioSep repo/README: https://github.com/Audio-AGI/AudioSep  
- DCASE 2024 T9 results: https://dcase.community/challenge2024/task-language-queried-audio-source-separation-results  
- DCASE baseline checkpoint (1.2 GB): https://zenodo.org/records/10887460  
- FlowSep: https://arxiv.org/abs/2409.07614 · https://github.com/Audio-AGI/FlowSep  
- FlowSep 2: https://arxiv.org/abs/2608.22111  
- Hybrid-Sep: https://arxiv.org/abs/2506.16833  
- CLIPSep: https://github.com/sony/CLIPSep · https://arxiv.org/abs/2212.07065  
- SAM Audio: https://arxiv.org/abs/2512.18099 · https://github.com/facebookresearch/sam-audio · SAM License in that repo  
- HTDemucs: https://research.facebook.com/publications/hybrid-transformers-for-music-source-separation/ · https://github.com/adefossez/demucs  
- Demucs weights statement: https://github.com/facebookresearch/demucs/issues/327  
- BS-RoFormer paper: https://arxiv.org/abs/2309.02612 · https://github.com/lucidrains/BS-RoFormer  
- ZFTurbo pretrained tables: https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md  
- Mega 53: https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v1.0.21  
- python-audio-separator: https://github.com/nomadkaraoke/python-audio-separator  
- MVSEP algorithms (ensemble 2025.06): https://mvsep.com (algorithms pages)  
- Liminal local: `D:\Projects\Liminal-StemSplit\` — `PROGRESS_REPORT_LATEST.md`, `scripts/model_registry.py`, `src/lib/model-catalog.ts`, `model_inference_tests_v047/RESULTS.md`

---

*This note does not constitute legal advice. License rows are research findings as of 2026-09-17.*
