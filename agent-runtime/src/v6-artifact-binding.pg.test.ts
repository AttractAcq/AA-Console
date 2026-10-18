import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('binds new links, preserves history, and allows campaign deletion', async () => {
 const db = new PGlite();
 try {
 await db.exec(`create table client_campaigns(id uuid primary key, client_id uuid, acquisition_mode text);
 create table campaign_manifest_versions(id uuid primary key, campaign_id uuid references client_campaigns on delete cascade, client_id uuid, version int, unique(id,campaign_id,client_id));
 create table campaign_artifacts(id int primary key, campaign_id uuid references client_campaigns on delete cascade, client_id uuid);
 insert into client_campaigns values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','paid');
 insert into campaign_manifest_versions select '00000000-0000-0000-0000-000000000003',id,client_id,1 from client_campaigns;
 insert into campaign_artifacts select 1,id,client_id from client_campaigns;`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261016200000_214_v6_campaign_artifact_manifest_binding.sql',import.meta.url),'utf8'));
 await db.exec('insert into campaign_artifacts select 2,id,client_id from client_campaigns');
 expect((await db.query('select manifest_id from campaign_artifacts order by id')).rows).toEqual([{manifest_id:null},{manifest_id:'00000000-0000-0000-0000-000000000003'}]);
 await db.exec(`insert into campaign_manifest_versions select '00000000-0000-0000-0000-000000000004',id,client_id,2 from client_campaigns;
 insert into campaign_artifacts select 3,id,client_id from client_campaigns;`);
 expect((await db.query('select manifest_id from campaign_artifacts where id=3')).rows[0]).toEqual({manifest_id:'00000000-0000-0000-0000-000000000004'});
 await expect(db.exec('update campaign_artifacts set manifest_id=null where id=2')).rejects.toThrow('immutable');
 await expect(db.exec('delete from campaign_manifest_versions where version=1')).rejects.toThrow();
 await db.exec('delete from client_campaigns');
 expect((await db.query('select * from campaign_artifacts')).rows).toEqual([]);
 } finally { await db.close(); }
},30000);
