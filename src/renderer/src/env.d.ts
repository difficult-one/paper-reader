import type { ReaderBridge } from '../../shared/types'
declare global { interface Window { reader: ReaderBridge } }
export {}
