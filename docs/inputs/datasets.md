# Runoff datasets

A *dataset class* reads your runoff files, converts the values to a rate in m/s and
hands them to the run loop in blocks of time steps. Each block is then mapped from
grid cells to catchments on the GPU (see [Runoff mapping](runoff-mapping.md)). The
classes live in `hydroforge.data.datasets` and run through PyTorch's `DataLoader`,
which reads the blocks in background processes.

The dataset also builds the run's **schedule**: every model time step with its date
(see [Time axis](../run/time-axis.md)).

## Arguments common to all datasets

| argument | meaning |
|---|---|
| `start_date`, `end_date` | First and last day of the simulation, both included. 2000-01-01 to 2000-12-31 with a 1-day step gives 366 steps. |
| `time_interval` | Time between two records in the source files. |
| `model_step` | Length of one model step, at most `time_interval`, which it must divide evenly. |
| `upsampling` | Required when `model_step` is shorter than `time_interval`, so one record covers several steps: `"repeat"` reuses the rate, `"distribute"` divides it by the number of steps. Must stay `None` (the default) when the two are equal. |
| `source_units`, `target_units` | Unit conversion of the raw values, e.g. `"mm day-1"` → `"m s-1"`. See [Units](#units). |
| `spin_up_cycles` | Number of times to replay the spin-up period before the main period; 0 disables spin-up. |
| `spin_up_start_date`, `spin_up_end_date` | The period each spin-up cycle replays. It may differ from the main period. |
| `chunk_len` | Records per block handed to the run loop. |
| `out_dtype` | Number format of the values (default `"float32"`). |
| `clip_negative` | Set negative runoff to 0 (default `False`). |
| `calendar` | Calendar of the dates (default: from the file metadata). |

The loader returns one block row per **record**, not per model step. With
`upsampling`, call `step_advance()` `time_interval // model_step` times per row, as
the scripts do with `reuse_count`.

In the grid cells the mapping uses, NaN becomes 0 and an infinite value stops the
run with an error.

## Units

The model wants runoff as a rate in m/s per grid cell (the mapping weights in m²
then give m³/s). Name the units of your files and the target:

```python
DailyBinDataset(..., source_units="mm day-1", target_units="m s-1")
```

The dataset converts with a fixed table of known units, including water flux
(`kg m-2 s-1`, `mm s-1`, `mm h-1`, `mm day-1`, `m s-1`) and water amount
(`kg m-2`, `mm`, `m`). A pair across the two families, such as ERA5-Land depth
per interval (`m`) to `m s-1`, needs an explicit `unit_factor`: the values are
divided by it (3600 for hourly records). Without `target_units`, values are only
divided by `unit_factor` (default 1).

## The dataset classes

**`DailyBinDataset`** reads raw float32 binary files, one per day, named
`{prefix}{YYYYMMDD}{suffix}` (default suffix `.one`), each holding one global grid of
`shape=(ny, nx)`. `time_interval` must be one day. Binary files record no units, so
give both `source_units` and `target_units`. `bin_dtype` sets the on-disk number format;
`lat_south_to_north` and `lon_0_to_360` set the grid orientation. For one file
holding many days, use `time_to_key=None` and `file_start_date`.

**`NetCDFDataset`** reads NetCDF files named `{prefix}{YYYY}{suffix}` (one per year
by default). `var_name` names the variable. It must have three dimensions: time
(`time` or `valid_time`, with CF time units), latitude (`lat`, `latitude` or `y`)
and longitude (`lon`, `longitude`, `long` or `x`). All files must share one grid.
With `target_units`, the source units come from the variable's `units` attribute
unless you set `source_units`. `chunk_len=None` picks the block size automatically. If the files are finer in time than `time_interval`, combine records
with `time_aggregation="mean"`, `"max"`, `"min"` or `"sum"`. A mapped view reads the
bounding box of the needed cells, or sparse tiles of it.

**`ERA5LandAccumDataset`** is a `NetCDFDataset` for ERA5-Land accumulated runoff
(`var_name="ro"`, monthly files `runoff_YYYY_MM.nc`). ERA5-Land sums runoff from the
start of the day; the class turns it back into per-interval amounts. The 00:00
value is the previous day's total; other hours subtract the previous record, across
file boundaries too. Record t covers [t, t+Δt), so the file containing
`end_date + Δt` must exist, and `time_interval` must divide one day evenly. The
values are depths in m per interval; `scripts/run_era5.py` converts them with
`source_units="m"`, `target_units="m s-1"` and `unit_factor=3600` for hourly data
(see [Units](#units)).

**`ExportedDataset`** reads runoff already converted to catchments; see
[below](#exporteddataset-convert-once-run-many-times).

Helpers for special cases:

- `open_multivariable(NetCDFDataset, ...)` and
  `open_multivariable(ExportedDataset, ...)` read several variables at once. Each
  block is a dictionary, and all variables share one mapping.
- `scripts/run_mix_runoff.py` adds two gridded sources: it sums the grid blocks of
  two NetCDF datasets (surface runoff and baseflow) on the GPU, then applies one
  shared mapping.
- `export_climatology(dataset, local_mapping, out_path, var_name=...)` writes the
  main-period mean per catchment to a NetCDF file (`saved_points`, `catchment_id`,
  the variable). `update_river_params.py` reads it (see
  [River network and parameters](model-input.md#updating-an-existing-file)).

## `ExportedDataset`: convert once, run many times

A gridded dataset reads the grid files, converts units, de-accumulates (ERA5) and
applies the mapping **on every run**. If you run the same forcing many times
(calibration, ensembles, experiments, several GPUs), do this once: export the
runoff per catchment (time × catchments) and let each later run read its own
columns. Runs then skip the mapping and the grid, read fewer bytes, and each GPU
reads independently. For small domains, `in_memory=True` keeps the whole file in
memory.

Export the main period (spin-up is not exported):

```python
from hydroforge.data.datasets import (NetCDFDataset, export_catchment_data,
                                      generate_mapping_table)

dataset = NetCDFDataset(...)            # or ERA5LandAccumDataset / DailyBinDataset
generate_mapping_table(dataset, map_dir, f"{out_dir}/runoff_mapping_nc.npz",
                       parameter_nc="parameters.nc")
view, local_mapping = dataset.build_local_mapping(
    f"{out_dir}/runoff_mapping_nc.npz")             # all catchments
export_catchment_data(view, local_mapping, out_dir,
                      var_name="runoff", units="m3/s", split_by_year=True)
```

The export writes `{var_name}_rank0.nc`, or `{var_name}_rank0_{YEAR}.nc` with
`split_by_year=True`: one file for all catchments, whatever the number of GPUs. It
has the dimensions `time` (unlimited) and `saved_points`, and the variables
`catchment_id(saved_points)` (int64) and `runoff(time, saved_points)` (float32 by
default). Each `time` value is the start of the interval, in "days since
1900-01-01 00:00:00". Pass `device="cuda"` to export on the GPU.

!!! warning
    Keep the default `normalized=False` for model forcing. `normalized=True`
    rescales each catchment's weights to sum to 1, which gives an area-weighted
    mean rate in m/s instead of the m³/s the model expects.

Run from the exported file. You need no mapping file, and `shard_forcing` takes no
mapping argument:

```python
dataset = ExportedDataset(base_dir=..., start_date=..., end_date=...,
                          time_interval=..., model_step=...,
                          var_name="runoff", prefix="runoff_",
                          suffix="rank0.nc", chunk_len=...)
model = CaMaFlood(..., simulation_schedule=dataset.simulation_schedule)
with model:
    dataset = dataset.selected(model.base.catchment_id.to("cpu").numpy())
    for chunk in DataLoader(dataset, batch_size=None, shuffle=False,
                            num_workers=2, pin_memory=True):
        for runoff in dataset.shard_forcing(chunk.to(device)):   # no mapping arg
            model.set_inputs(runoff=runoff)
            model.step_advance()
```

For files split by year, use `prefix="runoff_rank0_", suffix=".nc",
time_to_key=yearly_time_to_key` (`from hydroforge.data.datasets import
yearly_time_to_key`). With spin-up, the spin-up period must lie inside the exported
period.

## Keeping the GPU busy

`DataLoader` workers (`num_workers`, each prefetching `prefetch_factor` blocks)
read and decode the next blocks while the GPU simulates the current one.
`pin_memory=True` with `non_blocking=True` overlaps the copy to the GPU as well.
Set `shuffle=False`: time steps must arrive in order.

On a GPU the run is usually limited by I/O, not computation. If the GPU waits for
input, raise `num_workers` or `chunk_len`, or export the forcing once with
`ExportedDataset`.
