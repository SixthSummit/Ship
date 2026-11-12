import { mergeFixtureApp } from "./app.js";

/** The base application with one extra output field on `accounts.read`. */
export const app = mergeFixtureApp("left");
