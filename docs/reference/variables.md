# Model variables

CaMa-Flood-GPU is split into **modules**. Each one adds its own physics and its
own variables. Open modules with `opened_modules` in `CaMaFlood(...)`, for example
`opened_modules=("base", "adaptive_time", "bifurcation")`. A variable has the same
name in the model input file, in checkpoints and in `OutputConfig(variables=...)`
(the scripts' `variables_to_save`). Names, meanings and units below are the ones
declared in `cmfgpu/modules/*.py`.

Pick a module:

<div class="module-switch" markdown>


=== "base"

    **Open it when:** Always (required). **Needs:** The model input file.

    The core physics: water storage, depth and flow in the river channel and on the
    floodplain of every catchment. Required: always list it in `opened_modules`. It
    reads the model input file built by `MERITMap` (see
    [River network and parameters](../inputs/model-input.md)).

    Settings: `gravity` = 9.8 m s⁻²; `min_kinematic_slope` = 1.0e-5, the smallest bed
    slope used for the kinematic wave.

    === "Saveable"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `river_outflow` | flow out of the river channel | m³ s⁻¹ | state |
        | `flood_outflow` | flow out of the floodplain | m³ s⁻¹ | state |
        | `river_storage` | water volume in the river channel, including any above bankfull | m³ | state |
        | `flood_storage` | water volume on the floodplain | m³ | state |
        | `river_depth` | water depth in the river | m | state |
        | `flood_depth` | water depth on the floodplain above bankfull | m | state |
        | `flood_fraction` | flooded fraction of the catchment area | – | state |
        | `river_cross_section_depth` | effective depth in the river-flow equation | m | state |
        | `flood_cross_section_depth` | effective depth in the floodplain-flow equation | m | state |
        | `flood_cross_section_area` | floodplain flow cross-section | m² | state |
        | `total_outflow` | `river_outflow + flood_outflow` | m³ s⁻¹ | derived |
        | `water_surface_elevation` | `river_depth + catchment_elevation − river_height`, above mean sea level | m | derived |
        | `flood_area` | `flood_fraction × catchment_area` | m² | derived |
        | `total_storage` | river + floodplain (+ levee-protected) storage; computed only when saved | m³ | derived |
        | `river_inflow` | total inflow into the river channel | m³ s⁻¹ | derived |
        | `flood_inflow` | total inflow to the floodplain | m³ s⁻¹ | derived |

    === "Inputs"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `catchment_id` | unique id of each catchment: 0-based grid position `ix * ny + iy` | – | network |
        | `downstream_id` | catchment it drains into; itself at a river mouth | – | network |
        | `catchment_basin_id` | basin number; catchments with the same number stay on one GPU | – | network |
        | `output_catchment_id` | catchments whose results are saved (the *saved points*) | – | network |
        | `river_width` | river-channel width | m | parameter |
        | `river_length` | river-channel length | m | parameter |
        | `river_height` | bankfull depth of the river channel | m | parameter |
        | `catchment_elevation` | mean ground elevation above mean sea level | m | parameter |
        | `catchment_area` | catchment surface area | m² | parameter |
        | `downstream_distance` | distance to the next catchment downstream | m | parameter |
        | `flood_depth_table` | floodplain depth vs. flooded fraction, one value per flood level | m | parameter |
        | `river_manning` | river Manning roughness, default 0.03 | s m⁻¹ᐟ³ | parameter |
        | `flood_manning` | floodplain Manning roughness, default 0.1 | s m⁻¹ᐟ³ | parameter |

    === "Forcing"

        | variable | meaning | unit |
        |---|---|---|
        | `runoff` | runoff entering each catchment: `set_inputs(runoff=...)`, required every step | m³ s⁻¹ |

    !!! hydroforge "Powered by HydroForge"
        `total_outflow`, `water_surface_elevation` and `flood_area` are never stored as full arrays: HydroForge compiles their formulas, like your own expressions, into the statistics kernel and evaluates them only at the saved points. `total_storage` is a compile-time switch of the storage kernel: unless you save it, its code is not even compiled.

=== "adaptive_time"

    **Open it when:** Most runs. **Needs:** Nothing.

    Chooses the number of sub-steps in each model step from the CFL stability rule (see
    [Time axis](../run/time-axis.md#sub-steps)). With it open, call
    `step_advance(num_sub_steps=None)`; without it, give a fixed `num_sub_steps`. It
    adds no input or saveable variables.

    Setting: `adaptive_time_factor` = 0.7 (above 0, at most 1), the safety factor in
    the time-step formula.

=== "bifurcation"

    **Open it when:** Deltas and braided rivers. **Needs:** An input file built with `bifori_file`.

    Flow through bifurcation channels, which link a catchment to a catchment other than
    its main downstream one, as in deltas. Each channel has several elevation levels.
    Needs a model input file built with `bifori_file`.

    === "Saveable"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `bifurcation_outflow` | flow through each channel, per level | m³ s⁻¹ | state |
        | `bifurcation_cross_section_depth` | cross-sectional water depth, per level | m | state |

    === "Inputs"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `bifurcation_path_id` | unique id of each channel | – | network |
        | `bifurcation_catchment_id` | catchment at the upstream end | – | network |
        | `bifurcation_downstream_id` | catchment at the downstream end | – | network |
        | `output_bifurcation_path_id` | channels whose results are saved (default: all) | – | network |
        | `bifurcation_length` | channel length | m | parameter |
        | `bifurcation_width` | channel width, per level | m | parameter |
        | `bifurcation_elevation` | channel-bed elevation above mean sea level, per level | m | parameter |
        | `bifurcation_manning` | Manning roughness, per level, default 0.03 | s m⁻¹ᐟ³ | parameter |

=== "levee"

    **Open it when:** You model flood defences. **Needs:** An input file built with `levee_flag`.

    Levees protect part of the floodplain until the water overtops them. Needs a model
    input file built with `levee_flag`. The protected-side state is declared in
    `base.py` but exists only when `levee` is open.

    === "Saveable"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `protected_storage` | water volume behind the levees | m³ | state |
        | `protected_depth` | water depth on the protected side, above the river bed | m | state |

    === "Inputs"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `levee_id` | unique id of each levee | – | network |
        | `levee_catchment_id` | catchment that hosts the levee | – | network |
        | `levee_crown_height` | crown height above the river bed; a crown below the levee base is raised to it | m | parameter |
        | `levee_fraction` | levee position, from 0 (at the channel) to just under 1 (far edge of the catchment) | – | parameter |
        | `levee_base_height` | base height above the river bed, from `flood_depth_table` and `levee_fraction` | m | computed at load |

=== "reservoir"

    **Open it when:** You model dams. **Needs:** Reservoir parameters (`reservoir_flag` or `update_dam_params.py`).

    Dam operation: each reservoir stores and releases water according to its volumes and
    target outflows. Needs reservoir parameters from `reservoir_flag` or
    `update_dam_params.py`. If `bifurcation` is also open, bifurcation channels that
    touch a dam catchment or the catchment just upstream of it are closed.

    === "Saveable"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `reservoir_total_inflow` | inflow to the reservoir from upstream, one value per catchment | m³ s⁻¹ | state |

        Without `reservoir_total_inflow` in the input the run is a cold start: each
        dam starts at its conservation volume. A checkpoint contains it, so a restart
        keeps the saved dam storage.

    === "Inputs"

        | variable | meaning | unit | kind |
        |---|---|---|---|
        | `reservoir_id` | unique id of each reservoir | – | network |
        | `reservoir_catchment_id` | catchment that hosts the reservoir | – | network |
        | `reservoir_capacity` | maximum storage capacity | m³ | parameter |
        | `conservation_volume` | conservation storage volume | m³ | parameter |
        | `emergency_volume` | emergency storage volume; above conservation, at most capacity | m³ | parameter |
        | `normal_outflow` | normal outflow rate | m³ s⁻¹ | parameter |
        | `flood_control_outflow` | flood-control outflow rate | m³ s⁻¹ | parameter |
        | `reservoir_area` | surface area at normal water level | m² | parameter |
        | `flood_volume` | (emergency − conservation) / 0.95 | m³ | computed at load |
        | `adjustment_volume` | conservation + 0.1 × flood volume; regulation starts here | m³ | computed at load |
        | `effective_normal_outflow` | normal outflow after the Yamazaki & Funato adjustment | m³ s⁻¹ | computed at load |
        | `adjustment_outflow` | (effective normal + flood-control outflow) / 2 | m³ s⁻¹ | computed at load |

</div>

## How to read the tables

Each module has up to three tabs:

- **Saveable**: names you can put in `OutputConfig(variables=...)`
  (see [Statistics and output](../run/statistics.md)).
- **Inputs**: values read from the model input file.
- **Forcing**: data you pass with `set_inputs()` at every step.

The *kind* column says where a value comes from:

| kind | where it comes from | in a [checkpoint](../outputs/checkpoint.md)? | saveable? |
|---|---|---|---|
| state | input file or checkpoint at the start (missing values start at 0), then evolves | yes, current value | yes |
| derived | computed on the GPU during the run | no | yes |
| network | ids and links in the input file | yes | no |
| parameter | input file; some have a default | yes | yes, but constant |
| computed at load | other parameters, when the model loads | no | no |
| forcing | `set_inputs()` at every step | no | no |

Variables with several levels per point (flood levels, bifurcation levels) get an
extra `levels` dimension when saved. Internal helpers (index lists, masks such as
`is_reservoir`, step counters, scratch buffers) are built automatically and are not
listed.

Scalar settings, such as `gravity`, are read from the model input like any other
value. Each section gives the default; override one with
`input_proxy.updated(values={"adaptive_time_factor": 0.5})`.
