# Community benchmark

!!! note "To be updated"
    The community benchmark is being prepared. Until it opens, see the run times in
    [Kang et al. (2026)](https://doi.org/10.5194/gmd-19-5623-2026).

<!-- hidden until the community benchmark opens

A shared spreadsheet collects CaMa-Flood-GPU run times on different hardware:

TODO: replace BENCHMARK_SHEET_ID
<https://docs.google.com/spreadsheets/d/BENCHMARK_SHEET_ID>

Add a row with your own measurement. To compare hardware, filter by configuration
(for example map = `glb_15min`, backend = `triton`, GPUs = 1) with the sheet's
column filters or filter views.

## Reference case

Report at least one row for this case, so numbers stay comparable:

- `scripts/run_daily_bin.py` with the real `glb_15min` map;
- the `cmf_v420_pkg` test runoff, 1° daily (`Roff____*.one`);
- the period 2000-01-01 to 2000-12-31 (366 model steps with `model_step` = 1 day);
- `opened_modules = ("base", "adaptive_time", "bifurcation")`;
- two measurements: **with output** (the script's default
  `{"mean": ["total_outflow"], "last": ["river_depth"]}`) and **without output**.

Rows for larger maps (`glb_06min`, `glb_03min`) are welcome too.

## What to measure

- Skip the first run in a new environment: it compiles and caches the GPU code. Do
  one warm-up run and time the second.
- Report the **wall time** from the start of the run until the model closes (the
  end of the script's `with model:` block), including initialization and
  background writes. Report the
  **initialization time** (up to the first `step_advance`) separately.
- For multi-GPU runs, report the **largest time over all GPU processes**. Compare
  speed-ups (1-GPU time divided by N-GPU time) for the same map, period and
  hardware.
- Record the sub-step mode: a fixed `num_sub_steps` and `adaptive_time` do
  different amounts of work per step.

## Columns of the sheet

| column | example |
|---|---|
| contributor | name or handle |
| date | 2026-09-28 |
| GPU model | NVIDIA GeForce RTX 4070 Ti |
| number of GPUs | 1 / 4 |
| GPU memory | 12 GB |
| CPU | AMD EPYC 9654 |
| OS | Ubuntu 24.04 (WSL2) |
| driver | 596.49 |
| CUDA/ROCm/Metal version | CUDA 13.2 |
| PyTorch | 2.14.0 |
| Triton | 3.8.0 |
| HydroForge commit | `a1b2c3d` |
| CaMa-Flood-GPU commit | `e4f5g6h` |
| backend | triton / cuda / metal |
| precision | FP32 / FP32 with mixed precision |
| map | glb_15min |
| catchments | 252383 |
| modules | base, adaptive_time, bifurcation |
| runoff dataset & resolution | cmf_v420_pkg test runoff, 1° daily |
| period & model steps | 2000, 366 daily steps |
| sub-step mode | adaptive / fixed N=360 |
| outputs | mean total_outflow + last river_depth / none |
| wall time (s) |  |
| init time (s) |  |
| SYPD | simulated years per day |
| notes | e.g. output_workers, loader_workers, chunking |

## Finding the versions

```bash
python -c "import torch, triton; print(torch.__version__, torch.version.cuda, triton.__version__)"
git -C CaMa-Flood-GPU rev-parse --short HEAD
pip freeze | grep -i hydroforge   # shows the git commit when installed from git
nvidia-smi
```

These print, in order: the PyTorch, CUDA build and Triton versions; the
CaMa-Flood-GPU commit; the HydroForge commit; the GPU model and driver.
-->
