import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d3 = require("../vendor/d3.v7.min.js");
const topojson = require("../vendor/topojson-client.3.min.js");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VIEWPORT = [975, 610];
const PRECISION = 2;

const rawStates = readJson("data/boundaries/states-census-2024-5m.geojson");
const rawCounties = readJson("data/boundaries/counties-census-2024-5m.geojson");
const usAtlasStates = readJson("data/boundaries/states-albers-10m.json");
const targetBounds = d3.geoPath().bounds(topojson.feature(usAtlasStates, usAtlasStates.objects.nation));

const projection = d3.geoAlbersUsa().fitSize(VIEWPORT, rawStates);

const projectedStatesRaw = projectFeatureCollection(rawStates, projection, {
  featureId: (feature) => feature.properties?.STUSAB || feature.id,
});
const projectedCountiesRaw = projectFeatureCollection(rawCounties, projection, {
  featureId: (feature) => feature.properties?.GEOID || feature.id,
});
const projectedStates = alignFeatureCollectionToBounds(projectedStatesRaw, targetBounds);
const projectedCounties = alignFeatureCollectionToBounds(projectedCountiesRaw, targetBounds);

writeJson("data/boundaries/states-census-2024-5m-projected.geojson", projectedStates);
writeJson("data/boundaries/counties-census-2024-5m-projected.geojson", projectedCounties);
writeCountyReferenceCsv(projectedStates, projectedCounties);

console.log(
  JSON.stringify(
    {
      states: projectedStates.features.length,
      counties: projectedCounties.features.length,
      statesPath: "data/boundaries/states-census-2024-5m-projected.geojson",
      countiesPath: "data/boundaries/counties-census-2024-5m-projected.geojson",
      referencePath: "data/reference/us-counties-fips.csv",
    },
    null,
    2,
  ),
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(ROOT, relativePath), JSON.stringify(value), "utf8");
}

function projectFeatureCollection(collection, projectionFn, options = {}) {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => projectFeature(feature, projectionFn, options)).filter(Boolean),
  };
}

function alignFeatureCollectionToBounds(collection, target) {
  const source = d3.geoPath().bounds(collection);
  const sourceWidth = source[1][0] - source[0][0];
  const sourceHeight = source[1][1] - source[0][1];
  const targetWidth = target[1][0] - target[0][0];
  const targetHeight = target[1][1] - target[0][1];
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const translateX = target[0][0] - source[0][0] * scaleX;
  const translateY = target[0][1] - source[0][1] * scaleY;

  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: transformGeometry(feature.geometry, scaleX, scaleY, translateX, translateY),
    })),
  };
}

function projectFeature(feature, projectionFn, options) {
  const geometry = projectGeometry(feature.geometry, projectionFn);
  if (!geometry) {
    return null;
  }

  return {
    type: "Feature",
    id: options.featureId ? String(options.featureId(feature)) : feature.id,
    properties: feature.properties || {},
    geometry,
  };
}

function projectGeometry(geometry, projectionFn) {
  if (!geometry) {
    return null;
  }

  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.map((ring) => projectRing(ring, projectionFn)).filter(Boolean);
    return rings.length ? { type: "Polygon", coordinates: rings } : null;
  }

  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates
      .map((polygon) => polygon.map((ring) => projectRing(ring, projectionFn)).filter(Boolean))
      .filter((polygon) => polygon.length);
    return polygons.length ? { type: "MultiPolygon", coordinates: polygons } : null;
  }

  return null;
}

function transformGeometry(geometry, scaleX, scaleY, translateX, translateY) {
  if (!geometry) {
    return null;
  }

  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) => ring.map((point) => transformPoint(point, scaleX, scaleY, translateX, translateY))),
    };
  }

  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring) => ring.map((point) => transformPoint(point, scaleX, scaleY, translateX, translateY))),
      ),
    };
  }

  return geometry;
}

function projectRing(ring, projectionFn) {
  const projected = ring.map((point) => projectPoint(point, projectionFn)).filter(Boolean);
  if (projected.length < 4) {
    return null;
  }

  const deduped = [projected[0]];
  for (let index = 1; index < projected.length; index += 1) {
    const previous = deduped[deduped.length - 1];
    const current = projected[index];
    if (previous[0] !== current[0] || previous[1] !== current[1]) {
      deduped.push(current);
    }
  }

  if (deduped.length < 4) {
    return null;
  }

  const closed = closeRing(deduped.slice(0, -1));
  return closed.length >= 4 ? closed : null;
}

function projectPoint(point, projectionFn) {
  const projected = projectionFn(point);
  if (!projected) {
    return null;
  }

  return [round(projected[0]), round(projected[1])];
}

function transformPoint(point, scaleX, scaleY, translateX, translateY) {
  return [round(point[0] * scaleX + translateX), round(point[1] * scaleY + translateY)];
}

function round(value) {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
}

function closeRing(points) {
  if (!points.length) {
    return [];
  }

  const closed = points.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    closed.push([first[0], first[1]]);
  }

  return closed;
}

function writeCountyReferenceCsv(statesCollection, countiesCollection) {
  const statesByFips = new Map(
    statesCollection.features.map((feature) => {
      const properties = feature.properties || {};
      return [
        String(properties.STATE || "").padStart(2, "0"),
        {
          state_abbr: String(properties.STUSAB || "").trim(),
          state_name: String(properties.NAME || properties.BASENAME || "").trim(),
        },
      ];
    }),
  );

  const rows = countiesCollection.features
    .map((feature) => {
      const properties = feature.properties || {};
      const stateFips = String(properties.STATE || "").padStart(2, "0");
      const state = statesByFips.get(stateFips) || { state_abbr: "", state_name: "" };
      return {
        fips: String(properties.GEOID || "").padStart(5, "0"),
        state_fips: stateFips,
        state_abbr: state.state_abbr,
        state_name: state.state_name,
        county_name: String(properties.NAME || properties.BASENAME || "").trim(),
      };
    })
    .sort((left, right) => left.fips.localeCompare(right.fips));

  const headers = ["fips", "state_fips", "state_abbr", "state_name", "county_name"];
  const csv =
    [headers.join(",")]
      .concat(rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")))
      .join("\n") + "\n";

  fs.writeFileSync(path.join(ROOT, "data/reference/us-counties-fips.csv"), csv, "utf8");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}
