/** @packageDocumentation Client-safe, operation-typed Angular form integration. */

export {
  type BodyOperationId,
  createOperationForm,
  defineOperationForm,
  type OperationBodyOf,
  type OperationForm,
  type OperationFormBinding,
  type OperationFormControls,
  type OperationFormDefinition,
  type OperationFormField,
  type OperationFormInitial,
  type OperationValidationIssue,
} from './create-operation-form';
export {
  bigintStringOperationFormCodec,
  identityOperationFormCodec,
  isoDateOperationFormCodec,
  type OperationFormCodec,
} from './operation-form-codecs';
