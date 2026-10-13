// Synthetic parser input; intentionally not part of the compiled application.
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export abstract class FixtureBase {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column("varchar", { default: "default" }) @Index() scopeId!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @DeleteDateColumn({ select: false }) deletedAt!: Date;
}
