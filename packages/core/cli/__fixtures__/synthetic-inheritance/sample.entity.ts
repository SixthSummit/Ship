// Independent synthetic inputs for decimal, JSON, nullable, and inheritance conversion.
import { Column, Entity } from "typeorm";
import { FixtureBase } from "./base.entity.js";

@Entity("sample")
export class Sample extends FixtureBase {
  @Column("varchar") label!: string;
  @Column("varchar", { default: "draft" }) status!: string;
  @Column("jsonb", { default: [] }) values!: number[];
  @Column("decimal", { precision: 10, scale: 2, default: 0 }) amount!: number;
  @Column("decimal", { precision: 5, scale: 2, default: 0 }) ratio!: number;
  @Column("decimal", { precision: 10, scale: 2, default: 0 }) balance!: number;
  @Column("varchar", { default: "cm" }) unit!: string;
  @Column("varchar", { nullable: true }) memo!: string | null;
}
