# Runoff mapping

Runoff comes on a regular latitude–longitude grid; CaMa-Flood unit catchments have
irregular shapes. A catchment can overlap several grid cells, and a grid cell can
feed several catchments (see Figures 2 and 4 in
[Kang et al., 2026](https://doi.org/10.5194/gmd-19-5623-2026)). The
**runoff mapping** is a table you build once that records how much of each grid
cell lies in each catchment.

## How the weights are computed

The weight between a catchment and a grid cell is their **overlap area**, summed
over the high-resolution CaMa pixels (for example the 1-minute pixels). For each
pixel of a catchment (file `catmxy`), the builder finds the runoff cell containing
the pixel centre and adds the pixel area (file `grdare`, km² converted to m²) to
W[catchment, cell]. The catchment's runoff input is then

```
catchment inflow (m3/s) = Σ_cells  runoff_rate (m/s) × overlap area (m2)
```

The weights are areas in m², not normalized fractions, so the result is a flow in
m³/s.

The Fortran tool `generate_inpmat` uses the same rule. For `glb_15min` against a 1°
grid both give the same 451,447 non-zero weights with identical float32 values.
CaMa-Flood-GPU differs in three ways: it sums the areas in 64-bit before storing
them as 32-bit, it has no 100-cell limit per catchment, and it raises an error when
a pixel falls outside the runoff grid (the Fortran tool skips the pixel).

<figure class="fig">

--8<-- "figures/runoff-mapping.svg"

<figcaption>Overlap areas of the high-resolution pixels are added up into a sparse weight matrix W. During the run, each GPU converts a whole block of runoff time steps with a single matrix multiplication.</figcaption>
</figure>

## Generating the table

Call `generate_mapping_table` with your dataset (any gridded class in
[Runoff datasets](datasets.md)); `scripts/make_runoff_map.py` is a full example:

```python
from hydroforge.data.datasets import generate_mapping_table

generate_mapping_table(
    dataset,
    ".../map/glb_15min",                          # CaMa map folder
    ".../inp/glb_15min/runoff_mapping_bin.npz",   # output file
)
```

Useful options:

| option | what it does |
|---|---|
| `hires_tag` | Sub-folder of the map folder with the high-resolution pixels (default `"1min"`). |
| `parameter_nc` | Keep the catchments of this model input file, in its order. |
| `source_nan_policy` | Grid cells that are NaN in the first runoff time step: `"keep"` leaves them; `"drop"` removes them and scales up the remaining weights so each catchment keeps its total area; `"nearest"` moves a catchment that lost all its cells to the nearest valid cell. |
| `allow_oob_zero` | Pixels outside the runoff grid contribute zero instead of raising an error (default `False`). |

The builder reads `mapdim.txt`, `nextxy.bin`, `{hires_tag}/location.txt` and the
tiles `{tile}.catmxy.bin` and `{tile}.grdare.bin` from the map folder.

**Build one mapping per pair of runoff grid and CaMa map.** Use the same grid
description (`shape`, `lat_south_to_north`, `lon_0_to_360`) to build and to run. At
run time the dataset's coordinates must match the stored `coord_lon` and
`coord_lat`; otherwise the loader asks you to rebuild the table.

## Inside the `.npz` file

The table is a `np.savez_compressed` file in the format
`hydroforge.spatial_mapping.v2`. It holds the weight matrix in compressed sparse row
(CSR) form: one row per catchment with its non-zero weights. Keys of a `glb_15min`
+ 1° file:

| key | type | shape | meaning |
|---|---|---|---|
| `target_ids` | int64 | (252383,) | row → CaMa `catchment_id` (`ix*ny+iy`, 0-based) |
| `sparse_data` | float32 | (451447,) | the weights: overlap areas in m² |
| `sparse_indices` | int64 | (451447,) | runoff cell of each weight, as a flat index `iy*nlon+ix` (0-based, latitude-major) |
| `sparse_indptr` | int64 | (252384,) | where each row starts in the two arrays above |
| `matrix_shape` | int64 | (2,) = [252383, 64800] | (number of catchments, nlat × nlon) |
| `coord_lon` | float64 | (360,) | longitudes of the runoff cell centres (−179.5 … 179.5) |
| `coord_lat` | float64 | (180,) | latitudes of the runoff cell centres, in file order (89.5 … −89.5) |
| `coverage` | float32 | (252383,) | total mapped area of each catchment, m² |
| `metadata_json` | str | () | method `"hires_aggregate"`, normalization `"sum"`, `source_shape`, `source_order "C"`, `target_kind "catchment"`, schema, producer |

For this pair a catchment draws on 1 to 7 grid cells, 1.79 on average. To load the
matrix:

```python
import numpy as np, scipy.sparse as sp

z = np.load("runoff_mapping_bin.npz")
z.files
W = sp.csr_matrix(
    (z["sparse_data"], z["sparse_indices"], z["sparse_indptr"]),
    shape=tuple(z["matrix_shape"]),
)
```

## Compared with the CaMa-Flood `inpmat` files

The Fortran model stores the same weights in two files:

- `diminfo_*.txt` has 11 lines: `nXX`, `nYY`, `nFLP`, `nXIN`, `nYIN`, `INPN` (the
  largest number of grid cells per catchment), the inpmat file name, and the west,
  east, north and south bounds.
- `inpmat-*.bin` is a direct-access binary file. Each record is one `(nXX, nYY)`
  map in Fortran order (x fastest). Records `1..INPN` hold the x index `inpx`
  (int32), records `INPN+1..2·INPN` the y index `inpy` (int32), and records
  `2·INPN+1..3·INPN` the area `inpa` (float32, m²). Indices are 1-based; 0 marks
  an unused slot. Together they form a padded array `(nXX, nYY, INPN)` over the
  whole map grid.

The Fortran model loops over the `INPN` slots of each catchment:
`runoff_catchment += runoff(inpx, inpy) × inpa / DROFUNIT`, where `DROFUNIT`
(default 86400×1000) converts mm/day to m/s.

| | CaMa `inpmat` | CaMa-Flood-GPU `.npz` |
|---|---|---|
| layout | padded array `(nXX, nYY, INPN)` | sparse rows, active catchments only |
| row key | grid position | `target_ids` |
| cell index | 1-based pair `inpx`/`inpy` | 0-based flat `iy*nlon+ix` |
| weights | m², float32, not normalized | m², float32, not normalized |
| unit conversion | `/DROFUNIT` inside the model | `source_units` → `target_units` when the runoff is read |
| missing runoff | cells equal to `RMIS` are skipped | NaN becomes 0 when read; `drop`/`nearest` when building |
| grid description | `diminfo` file plus generator arguments | stored `coord_lon`/`coord_lat`, checked at run time |

To use an `.npz` table with the Fortran model, convert it with `export_inpmat` in
`cmfgpu/params/export_bin.py`.

<figure class="fig">

--8<-- "figures/npz-vs-inpmat.svg"

<figcaption>Both files store the same weights: inpmat as padded records over the whole map, npz as sparse rows over active catchments.</figcaption>
</figure>

## What happens during the run

At start-up each GPU extracts its part of the table:

```python
dataset, local_mapping = dataset.build_local_mapping(
    runoff_mapping_file,
    model.base.catchment_id.to("cpu").numpy(),
    device=device,
)
```

`build_local_mapping` keeps the rows of this GPU's catchments, in the model's
order, and the runoff cells with a non-zero weight. It returns two things: a view
of the dataset that reads only the part of the grid holding those cells (the
latitude rows that span them for binary files; their bounding box, or sparse tiles
of it, for NetCDF), and a sparse matrix of shape (catchments on this GPU × active
cells).

Convert each block of time steps from gridded to catchment runoff with one call:

```python
runoff_chunk = dataset.shard_forcing(chunk.to(device), local_mapping)
```

`shard_forcing` multiplies the block (time steps × active cells) by the weight
matrix in one GPU matrix multiplication, giving (time steps × catchments). In a
multi-GPU run each GPU does this for its own basins; GPUs exchange no runoff.

!!! hydroforge "Powered by HydroForge"
    HydroForge builds the weight matrix on NVIDIA and AMD GPUs in compressed sparse row (CSR) form, the layout the GPU's sparse library multiplies directly, so no format conversion happens per block.

Before the multiplication, raw values are converted to a rate in m/s
(`source_units="mm day-1"`, `target_units="m s-1"` for the daily binary files; see
[Units](datasets.md#units)). The weights (m²) turn m/s into m³/s. A catchment
covered by no runoff cell gets zero runoff; `generate_mapping_table` warns about
such catchments when it builds the table.

See [Runoff datasets](datasets.md) for the dataset classes and
[Configuration](../run/configuration.md) for the settings in the run script.
