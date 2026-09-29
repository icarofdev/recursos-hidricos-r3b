-- MACs antigos são desconhecidos: preservar NULL, códigos, ativações e vínculos.
ALTER TABLE devices ADD COLUMN mac_address TEXT
 CHECK(mac_address IS NULL OR (
   length(mac_address)=17 AND
   substr(mac_address,3,1)=':' AND substr(mac_address,6,1)=':' AND
   substr(mac_address,9,1)=':' AND substr(mac_address,12,1)=':' AND
   substr(mac_address,15,1)=':' AND
   replace(mac_address,':','') NOT GLOB '*[^0-9A-F]*'
 ));
CREATE UNIQUE INDEX devices_mac_unique ON devices(mac_address) WHERE mac_address IS NOT NULL;
-- Bloqueia novas associações duplicadas inclusive por diferença de maiúsculas,
-- sem falhar a migração caso algum dado legado já esteja inconsistente.
CREATE TRIGGER monitorie_external_unique_insert BEFORE INSERT ON devices
WHEN NEW.source='monitorie' AND NEW.external_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM devices d WHERE d.source='monitorie'
 AND lower(d.external_id)=lower(NEW.external_id))
BEGIN SELECT RAISE(ABORT,'MONITORIE_ID_IN_USE'); END;
CREATE TRIGGER monitorie_external_unique_update BEFORE UPDATE OF external_id,source ON devices
WHEN NEW.source='monitorie' AND NEW.external_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM devices d WHERE d.id<>NEW.id AND d.source='monitorie'
 AND lower(d.external_id)=lower(NEW.external_id))
BEGIN SELECT RAISE(ABORT,'MONITORIE_ID_IN_USE'); END;
