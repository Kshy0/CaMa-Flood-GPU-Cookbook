# Checkpoint and restart

A **checkpoint** holds the complete model state at one moment: the river network,
the parameters and the current water in rivers, floodplains and reservoirs. Start
a new run from it to continue a simulation, or to reuse a spin-up instead of
repeating it.

## Saving

Call `model.save_state()` after the run loop, inside the `with model:` block. It
needs an output folder (`OutputConfig(dir=...)`).

```python
with model:
    for runoff_chunk in loader:
        ...
    if save_state:
        model.save_state()
```

This writes `output_dir/experiment_name/model_state_{YYYYmmdd_HHMMSS}_step{index}.nc`.
The date and time in the name are the model's current date; a restart does not
read them. Pending statistics are written first. The checkpoint goes to a
temporary name and is renamed when complete, so a crash leaves no half-written
file.

In a multi-GPU run each GPU process writes its part to a hidden temporary file.
Rank 0 merges the parts into the same single
`model_state_{YYYYmmdd_HHMMSS}_step{index}.nc` and deletes them, so you always get
one checkpoint file, whatever the number of GPUs.

!!! hydroforge "Powered by HydroForge"
    HydroForge saves a multi-GPU checkpoint as one transaction: all GPUs confirm each phase before the next begins, and if any GPU fails before the merged file is published, every GPU removes its part.

## What a checkpoint contains

A checkpoint has the same structure as the model input file: the river network,
parameters and state variables of the switched-on modules (see
[Model variables](../reference/variables.md) for these categories). State
variables hold their **current** values: river and floodplain storage and depth,
outflows, bifurcation flows, reservoir inflow, and so on.

| content | saved? |
|---|---|
| river network (`downstream_id`, `catchment_basin_id`, …) | yes |
| parameters (`river_width`, `flood_depth_table`, …) | yes |
| state (`river_storage`, `river_depth`, `flood_outflow`, …) | yes, with current values |
| variables computed from others (`total_outflow`, `water_surface_elevation`, …) | no; recomputed when loaded |
| runoff and other forcing | no |
| partly accumulated statistics | no |
| model date, calendar, spin-up progress, position in the schedule | no |
| map metadata (`longitude`, `latitude`, gauges, `nx`/`ny`, global attributes) | no |

Dimension names in a checkpoint are generic (`{var}_dim0`, `{var}_n`) rather than
`catchment`.

Keep the original model input file: `update_river_params.py`,
`update_dam_params.py` and any longitude/latitude lookup need its map metadata.

## Restarting

Open the checkpoint as the `input_proxy` of a **new** `CaMaFlood`, and build a new
dataset and schedule for the next period. Set the calendar, the spin-up and
`opened_modules` again:

```python
input_proxy = InputProxy.from_nc(".../model_state_20010101_000000_step366.nc")

dataset = DailyBinDataset(..., start_date=datetime(2001, 1, 1),
                          end_date=datetime(2001, 12, 31),
                          spin_up_cycles=0, ...)        # warm start: no spin-up
model = CaMaFlood(..., input_proxy=input_proxy,
                  opened_modules=opened_modules,        # open the same modules
                  simulation_schedule=dataset.simulation_schedule)
```

- **Switch on the same modules.** A module that was off has no state in the
  checkpoint. Reservoir inflow, for instance, carries over only if the `reservoir`
  module is on in both runs.
- **Skip the spin-up** (`spin_up_cycles=0`). The saved water volumes are already
  in balance.

A single-GPU restart reproduces an uninterrupted run bit for bit (tested on CUDA).

## Spin up once, reuse many times

Run the spin-up period once with `save_state()`, then start every experiment from
that file. Combined with
[saving only chosen catchments](../run/statistics.md#saving-only-chosen-catchments),
this makes parameter tests on a spun-up state cheap.
