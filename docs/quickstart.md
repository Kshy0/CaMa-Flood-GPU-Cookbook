# Quick start

Four steps from a fresh clone to output files. Run all commands from the
`CaMa-Flood-GPU/` repository folder.

## 0. Get the data and set your paths

Download the `cmf_v420_pkg` data package (maps and test runoff) from the
[CaMa-Flood site](https://hydro.iis.u-tokyo.ac.jp/~yamadai/cama-flood/).

Each script in `scripts/` keeps its settings, including file paths, in a block
marked `Configuration Start`. Copy the folder so `git pull` does not overwrite your
edits:

```bash
cp -r scripts scripts_user
```

Set the paths in each `scripts_user/` script you use. On Windows write paths as raw
strings, e.g. `input_file = fr"C:\Users\YourName\inp\glb_15min\parameters.nc"`.

## 1. Build the model input file

```bash
python scripts_user/make_map_params.py
```

This reads a CaMa-Flood map folder and writes `parameters.nc`: the river network,
channel and floodplain parameters and an initial water state. Set the map folder
(`map_dir`), output folder (`out_dir`), bifurcation file (`bifori_file`), optional
gauge list (`gauge_file`) and number of GPUs you plan to use (`target_gpus`).

The `glb_15min` package ships river width and depth. For other resolutions,
estimate them from a runoff climatology:

```bash
python scripts_user/update_river_params.py
```

Details: [River network and parameters](inputs/model-input.md).

## 2. Build the runoff mapping

```bash
python scripts_user/make_runoff_map.py
```

This writes `runoff_mapping_bin.npz`, the weights that map each runoff grid cell to
the catchments it drains into. Details: [Runoff mapping](inputs/runoff-mapping.md).

## 3. Run the model

```bash
python scripts_user/run_daily_bin.py                      # 1 GPU
torchrun --nproc_per_node=4 scripts_user/run_daily_bin.py # 4 GPUs, one computer
```

`torchrun` starts one process per GPU; the script stays the same. Each GPU gets a
set of whole river basins and reads only the runoff cells its catchments need.

On a GPU, reading input and writing output usually limit speed, not the simulation.
List the results you need in `variables_to_save` (for example the daily mean
discharge) and let the model compute them during the run instead of saving raw
fields to post-process. See [Statistics and output](run/statistics.md).

## 4. Find the outputs

Outputs go to `output_dir/experiment_name/`, one NetCDF file per saved variable and
per GPU, e.g. `total_outflow_mean_rank0.nc` (`rank0` is the first GPU). See
[Output files](outputs/output-files.md) and
[Checkpoint and restart](outputs/checkpoint.md).

## Other run templates

| script | what it shows |
|---|---|
| `run_netcdf.py` | Runoff from yearly NetCDF files (E2O example). |
| `run_era5.py` | Hourly ERA5-Land accumulated runoff, with daily statistics. |
| `run_mix_runoff.py` | Adds surface runoff and baseflow from two NetCDF datasets on the GPU. |
| `update_dam_params.py` | Estimates reservoir parameters from the `total_outflow_max_mean` and `total_outflow_mean_mean` output of a run without dams. |
