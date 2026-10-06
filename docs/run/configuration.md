# Configuration

You configure a run in one Python script; start from `scripts/run_daily_bin.py`.
A *model step* is one model time step as your script sees it (here one day);
*sub-steps* are the shorter solver steps inside it. See [Time axis](time-axis.md)
for how dates become steps and [Statistics and output](statistics.md) for the
`variables_to_save` syntax.

## Settings in `run_daily_bin.py`

**Model and output**

| name | example | purpose |
|---|---|---|
| `resolution` | `"glb_15min"` | map name, used to build the paths below |
| `experiment_name` | `"glb_15min_bin"` | sub-folder created under `output_dir` |
| `input_file` | `inp/glb_15min/parameters.nc` | model input file (river network, parameters and initial state) |
| `output_dir` | `out/` | root folder for all outputs |
| `opened_modules` | `("base", "adaptive_time", "bifurcation")` | physics modules to switch on |
| `num_sub_steps` | `360` | fixed number of sub-steps per model step; `None` with `adaptive_time` |
| `variables_to_save` | `{"mean": ["total_outflow"], "last": ["river_depth"]}` | statistics to compute and write |
| `output_split_by_year` | `False` | write one output file per year |
| `save_state` | `False` | write a checkpoint after the last step |

**Runoff input**

| name | example | purpose |
|---|---|---|
| `runoff_dir` | `cmf_v420_pkg/inp/test_1deg/runoff` | folder with the runoff files |
| `runoff_mapping_file` | `inp/glb_15min/runoff_mapping_bin.npz` | runoff-to-catchment table ([Runoff mapping](../inputs/runoff-mapping.md)) |
| `runoff_shape` | `(180, 360)` | `(ny, nx)` of the runoff grid |
| `runoff_time_interval` | `timedelta(days=1)` | time between runoff records; also `model_step` |
| `start_date` / `end_date` | `2000-01-01` / `2000-12-31` | simulation period, end date included |
| `source_units` / `target_units` | `"mm day-1"` / `"m s-1"` | unit conversion of the raw values to m s⁻¹ (binary files record no units); the mapping weights (m²) then give m³ s⁻¹ |
| `bin_dtype` | `"float32"` | number format of the binary runoff files |
| `prefix` / `suffix` | `"Roff____"` / `".one"` | runoff file names are `prefix + date + suffix` |
| `lat_south_to_north` | `False` | `True` if rows run south to north |
| `lon_0_to_360` | `False` | `True` if columns start at 0°E instead of −180° |
| `spin_up_cycles` | `0` | number of spin-up cycles before the main period |
| `spin_up_start_date` / `spin_up_end_date` | `2000-01-01` / `2000-12-31` | period replayed by each spin-up cycle |

**Performance**

| name | example | purpose |
|---|---|---|
| `loader_workers` | `2` | background processes that read runoff |
| `prefetch_factor` | `2` | blocks of runoff each reader prepares in advance |
| `output_workers` | `2` | background processes that write results (`0` = write directly, and wait) |
| `BLOCK_SIZE` | `128` | catchments per GPU thread block (tuning knob) |

The script hands `output_dir`, `experiment_name`, `variables_to_save`,
`output_workers` and `output_split_by_year` to
[`OutputConfig`](#outputconfig-fields), and `BLOCK_SIZE` to `CaMaFlood(block_size=...)`.

To run on several GPUs of one computer, launch the same script with
`torchrun --nproc_per_node=4 run_daily_bin.py`. Each process (a *rank*) drives one
GPU, gets a set of whole river basins, and reads only the runoff cells its
catchments need.

## `CaMaFlood(...)` keywords

| keyword | default | purpose |
|---|---|---|
| `device` | `"cpu"` | where to compute; usually from `setup_distributed(allowed_devices=("cuda", "mps"))` |
| `input_proxy` | required | model input file opened with `InputProxy.from_nc(...)`, or a checkpoint |
| `opened_modules` | required | `base` (required), `adaptive_time`, `bifurcation`, `levee`, `reservoir`, `sea_level`, `inflow`, `log` |
| `simulation_schedule` | `None` | list of model steps from the dataset (`dataset.simulation_schedule`) |
| `output` | `OutputConfig()` | what to compute and write, see below |
| `precision` | `"float32"` | floating-point precision of the model |
| `mixed_precision` | `None` → on for NVIDIA, AMD and Apple GPUs, off elsewhere | store water volumes (river and floodplain storage and other storage variables) in double precision in a 32-bit model, so small changes survive rounding; see [Choosing a backend](../install.md#choosing-a-backend) for Metal |
| `block_size` | `None` (per-kernel default) | GPU thread-block size override (the script uses 128) |
| `execution_mode` | `"auto"` | `"auto"` records a step's GPU work once and replays it where supported (NVIDIA with CUDA 12.4+, and Apple GPUs; ROCm runs step by step); `"eager"` launches each kernel separately, for debugging |

!!! hydroforge "Powered by HydroForge"
    With `execution_mode="auto"`, HydroForge records one sub-step, physics kernels and statistics update together, as a CUDA graph or, on Apple GPUs, a Metal indirect command buffer. The following sub-steps replay that recording, so the CPU no longer launches the kernels one by one.

Enter the model with `with model:` before the run loop. Entering loads and splits
the input file and starts the output writers; leaving the block waits for pending
results and closes the model, also when a step fails.

## `OutputConfig(...)` fields

`OutputConfig` (from `hydroforge.model`) is passed as `CaMaFlood(output=...)`.

| field | default | purpose |
|---|---|---|
| `dir` | `None` | root folder for outputs; `None` writes no files at all |
| `experiment` | `"experiment"` | sub-folder of `dir` for this run |
| `variables` | `{}` | `{operation: [variables]}`, see [Statistics and output](statistics.md) |
| `statistics_plan` | `None` → every model step | inner and outer statistics windows and `partial_period` |
| `save_precision` | `"float32"` | precision of the written statistics; `None` keeps the GPU precision |
| `workers` | `2` | background writer processes; `0` writes directly |
| `split_by_year` | `False` | write `{var}_{op}_rank{r}_{year}.nc`, one file per year |
| `max_pending_steps` | `200` | pause the model when this many finished results wait to be written |
| `sink` | `"netcdf"` | `"memory"` keeps results in memory instead; read them with `model.results.get(var, op)` |
| `netcdf` | Blosc-Zstd level 5 | compression of output files; e.g. `{"compression": "zlib", "complevel": 4}` for readers without the Blosc plugin |
| `checkpoint_netcdf` | Blosc-Zstd level 5 | compression options for `save_state()` output |

Two modules need input at every step: pass `set_inputs(sea_surface_elevation=...)`
for `sea_level` and `set_inputs(inflow=...)` for `inflow`.

## Environment

| setting | effect |
|---|---|
| `HYDROFORGE_BACKEND` | which technology generates the GPU code: `triton` (default on NVIDIA and AMD), `cuda` (CUDA C++ compiled with NVRTC, or hiprtc on AMD) or `metal` (default on Apple). See [Installation](../install.md#choosing-a-backend). |
| `torchrun --nproc_per_node=N` | start a run on N GPUs of one computer |

The GPU code compiles on first use and is cached on disk, so the first run in a new
environment starts slower.

!!! warning "Guard the entry point"
    Put the run code in a `main()` function behind `if __name__ == "__main__":`.
    The output writers and runoff readers are separate processes that re-import your
    script; without the guard the writers crash with `BrokenProcessPool`.

## Performance tips

- Use FP32 (`precision="float32"`). Mixed precision, on by default on GPUs, keeps
  water volumes in double precision.
- Keep outputs small: compute statistics during the run and save only the
  catchments you need
  ([Saving only chosen catchments](statistics.md#saving-only-chosen-catchments)).
- If reading runoff is the bottleneck, raise `loader_workers` or `prefetch_factor`,
  or convert the forcing once with `ExportedDataset`
  ([Runoff datasets](../inputs/datasets.md#exporteddataset-convert-once-run-many-times)).
- Keep `output_workers > 0` so writing overlaps with the next steps.
- To time a run consistently, see the [benchmark page](../benchmark.md).
