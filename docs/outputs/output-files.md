# Output files

Statistics are written to `output_dir/experiment_name/`. `rank{r}` in a file name
is the GPU process that wrote it; a single-GPU run has only `rank0`.

| file | content |
|---|---|
| `{variable}_{op}_rank{r}.nc` | one file per saved variable and operation, per GPU, e.g. `total_outflow_mean_rank0.nc` |
| `{variable}_{op}_rank{r}_{year}.nc` | the same, one file per year, with `OutputConfig(split_by_year=True)` (`output_split_by_year` in the scripts) |
| `..._max3_mean_0.nc`, `..._1.nc`, `..._2.nc` | top-k operations: one file per position (largest, second largest, …) |
| `model_manifest.json` | run information: backend, device, `experiment_name`, `mixed_precision`, model, `opened_modules`, options, `precision` (and `metal_emulation` when it is used) |

## Inside a file

`ncdump -h` of a `total_outflow_mean_rank0.nc` (`glb_15min`, one GPU, 366 daily
steps, all catchments saved):

```
netcdf total_outflow_mean_rank0 {
dimensions:
	time = UNLIMITED ; // (366 currently)
	saved_points = 252383 ;
variables:
	int64 catchment_id(saved_points) ;
	double time(time) ;
		time:units = "days since 1900-01-01 00:00:00" ;
		time:calendar = "standard" ;
	float total_outflow_mean(time, saved_points) ;
		total_outflow_mean:description = "Total outflow from catchment (river + flood) (m3 s-1) (mean)" ;
		total_outflow_mean:actual_shape = "(252383,)" ;
		total_outflow_mean:tensor_shape = "('num_catchments',)" ;
		total_outflow_mean:long_name = "total_outflow_mean" ;
// global attributes:
		:title = "Time series for rank 0: total_outflow_mean" ;
		:original_variable_name = "total_outflow_mean" ;
		:hydroforge_output_format = "hydroforge.statistics" ;
		:hydroforge_output_version = 3LL ;
		:hydroforge_rank = 0LL ;
		:hydroforge_world_size = 1LL ;
		:hydroforge_run_id = "..." ;
		:hydroforge_committed_steps = 366LL ;
		:hydroforge_coordinate = "catchment_id" ;
}
```

- **`time`**: one value per finished statistics window, stamped with the *start*
  of the window in `days since 1900-01-01`. Two-level statistics are stamped
  differently; see [Time axis](../run/time-axis.md#statistics-windows). The
  dimension is unlimited and grows while the run writes.
- **`saved_points`**: the catchments this GPU wrote, as selected by
  `output_catchment_id` (252,383 is all of `glb_15min`).
- **`catchment_id`**: the id of each saved point, in the column order of the data.
  The 0-based grid position is `ix = catchment_id // ny`,
  `iy = catchment_id % ny`, where `ny` is the number of map rows (a global
  attribute of the model input file).
- **`total_outflow_mean(time, saved_points)`**: the data. `description` gives the
  meaning and unit, with the operation in parentheses. `actual_shape` is the shape
  of one record on the saved points; `tensor_shape` names the model dimension the
  variable is defined on (`num_catchments` here).
- **Global attributes**: `hydroforge_output_format` and `_version` identify the
  file layout. `hydroforge_rank` and `_world_size` give the writing GPU process
  and the number of processes. `hydroforge_run_id` is shared by all files of one
  run. `hydroforge_committed_steps` counts the steps whose results are complete in
  the file. `hydroforge_coordinate` names the id variable of `saved_points`.

!!! hydroforge "Powered by HydroForge"
    HydroForge appends each batch, syncs the file, and only then raises `hydroforge_committed_steps`, so a run that stops mid-write leaves every committed row intact. `MultiRankStatsReader` reads only the time range that every GPU has committed.

Variables with several levels per point, such as bifurcation-channel flows, have
an extra `levels` dimension: `(time, saved_points, levels)`.

## Reading the files

Open a file with any NetCDF reader. `xarray.open_dataset("total_outflow_mean_rank0.nc")`
gives a `(time, saved_points)` array with `catchment_id` as a coordinate.

Files are compressed with **Blosc-Zstd** by default, which needs a netCDF-C
library built with the Blosc filter plugin. If your tools cannot open the files,
switch to standard compression with
`OutputConfig(netcdf={"compression": "zlib", "complevel": 4})` (see
[Configuration](../run/configuration.md#outputconfig-fields)).

In a multi-GPU run each GPU writes its own catchments. Combine the files of all
GPUs with the bundled reader:

```python
from hydroforge.io import MultiRankStatsReader

reader = MultiRankStatsReader(base_dir="out/glb_15min_bin",
                              var_name="total_outflow_mean")
series = reader.get_series(ids)   # ids: catchment ids; result (time, len(ids))
```

It shows the time range that **all** GPUs have finished writing. Pass
`split_by_year=True` for files split by year.

Results are written in the background while the model runs (see
[Saving runs in the background](../run/statistics.md#saving-runs-in-the-background)).
Leaving the script's `with model:` block (or calling `model.close()`) waits until
every result is on disk.

To keep results in memory instead of writing files, pass
`OutputConfig(sink="memory")` and read them with `model.results.get(var, op)`.
