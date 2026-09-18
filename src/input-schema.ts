import * as z from "zod/v4";

const numericString = z.string().trim().regex(
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,
  "Coordinate must be a finite number or numeric string."
);

export const finiteCoordinateSchema = z.union([z.number(), numericString])
  .transform((value) => typeof value === "number" ? value : Number(value))
  .refine(Number.isFinite, "Coordinate must be finite.");

export const sceneCameraSchema = z.object({
  position: z.tuple([finiteCoordinateSchema, finiteCoordinateSchema, finiteCoordinateSchema]),
  target: z.tuple([finiteCoordinateSchema, finiteCoordinateSchema, finiteCoordinateSchema])
});
