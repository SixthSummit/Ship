import { mergeFixtureApp } from "./app.js";

/** The base application with one extra query field on `reports.summary`. */
export const app = mergeFixtureApp("right");
