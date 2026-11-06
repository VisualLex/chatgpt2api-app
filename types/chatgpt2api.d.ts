/** Public, independent DSH Host service contract; never returns account tokens or admin secrets. */
export interface ImageReference {
  dataBase64: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
}
export interface GenerateImageInput {
  prompt: string;
  model?: string;
  n?: 1;
  size?: string;
  referenceImages?: ImageReference[];
}
export interface GenerateImageResult {
  model: string;
  data: Array<{b64_json:string;url:string}>;
  usage: unknown;
  created: number|null;
}
export interface PoolSummary {
  total:number;active:number;limited:number;abnormal:number;disabled:number;
  totalQuota:number;totalSuccess:number;totalFail:number;
}
export interface ChatGPT2APIServiceContract {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  health(): Promise<{connected:true;healthy:boolean;status:string;version:string;accounts:PoolSummary}>;
  poolSummary(): Promise<PoolSummary>;
  models(): Promise<string[]>;
  generateImage(input:GenerateImageInput): Promise<GenerateImageResult>;
  chatCompletion(input:{model?:string;messages:Array<unknown>;[key:string]:unknown}):Promise<unknown>;
  createResponse(input:{model?:string;input:unknown;[key:string]:unknown}):Promise<unknown>;
  connectionInfo():{baseUrl:string;apiBaseUrl:string;authentication:string;localOnly:boolean;methods:string[]};
  managedStatus():{managed:boolean;runtime?:string;phase:string;baseUrl:string;message?:string;error?:string;dataDir?:string};
}
