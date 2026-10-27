import { Grid, Typography } from '@linagora/twake-mui'
import { useT } from '../i18n/useT.js'
import { Dialer } from './Dialer.js'
import { Directory } from './Directory.js'

/** The home page: the people to call on the left, the keypad on the right (one above the other on a narrow screen). */
export const Phone = () => {
  const { t } = useT()
  return (
    <>
      <Typography variant="h4" component="h1" className="u-visuallyhidden">
        {t('phone.title')}
      </Typography>
      <Grid container spacing={4}>
        <Grid size={{ xs: 12, md: 7 }} component="section" aria-labelledby="directory-title">
          <Directory />
        </Grid>
        <Grid size={{ xs: 12, md: 5 }} component="section" aria-labelledby="dialer-title">
          <Dialer />
        </Grid>
      </Grid>
    </>
  )
}
