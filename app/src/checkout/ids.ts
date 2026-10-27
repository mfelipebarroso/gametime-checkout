// `react-native-get-random-values` must be imported before `uuid` (it is, in index.js).
import { v4 as uuidv4 } from 'uuid';

export function newAttemptId(): string {
  return uuidv4();
}
