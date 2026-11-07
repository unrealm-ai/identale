/** Trusted storage metadata only. Payload values remain in private immutable files.
 * Implementations share the SAME transaction/owner fence as runtime Session state. */
export interface JournalRecordIndex {recordId:string;kind:string;bytes:number;executionKey?:string;runKey?:string}
export interface JournalContextHead {version:string;refs:readonly import('./journal.js').JournalRef[];checksum:string}
export interface JournalIndexPort {
 migrated(resourceId:string):boolean;
 markMigrated(resourceId:string):void;
 get(resourceId:string,recordId:string):JournalRecordIndex|undefined;
 add(resourceId:string,record:JournalRecordIndex):void;
 list(resourceId:string,kind:string):readonly JournalRecordIndex[];
 head(resourceId:string):JournalContextHead|undefined;
 setHead(resourceId:string,head:JournalContextHead):void;
 remove(resourceId:string):void;
}
