import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://syxjtzvekdqsgwtazclp.supabase.co'

const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5eGp0enZla2Rxc2d3dGF6Y2xwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwODQxMzksImV4cCI6MjA5NTY2MDEzOX0.eBLy_3QwruScz-Y2eSZBO_ASVfzpJvNzuoA5ptq7v40'
//console.log("KEY:", supabaseKey)
export const supabase = createClient(
  supabaseUrl,
  supabaseKey
)