// Writes docker/opensips/subscriber.sql and docker/opensips/trunk.sql from the built package (yarn build first):
// unit tests compare them with SUBSCRIBER_SQL and TRUNK_SQL.
import { writeFileSync } from 'node:fs'
import { SUBSCRIBER_SQL, TRUNK_SQL } from '../dist/index.js'

writeFileSync(new URL('../../../docker/opensips/subscriber.sql', import.meta.url), SUBSCRIBER_SQL)
writeFileSync(new URL('../../../docker/opensips/trunk.sql', import.meta.url), TRUNK_SQL)
